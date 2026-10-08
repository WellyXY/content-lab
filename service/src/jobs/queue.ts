import { randomUUID } from "node:crypto";

import type { ContentLabDatabase } from "../db/database.js";
import { putSyncEvent } from "../sync/outbox.js";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  status: "queued" | "running" | "succeeded" | "failed" | "dead";
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  syncRemoteId: string | null;
}

interface JobRow {
  id: string; kind: string; payload_json: string; status: Job["status"]; run_at: string;
  attempts: number; max_attempts: number; locked_until: string | null; lease_owner: string | null;
  last_error: string | null; sync_remote_id: string | null;
}

const mapJob = <T>(row: JobRow): Job<T> => ({
  id: row.id, kind: row.kind, payload: JSON.parse(row.payload_json) as T, status: row.status,
  runAt: row.run_at, attempts: row.attempts, maxAttempts: row.max_attempts,
  lockedUntil: row.locked_until, leaseOwner: row.lease_owner, lastError: row.last_error,
  syncRemoteId: row.sync_remote_id,
});

export function enqueueJob(
  db: ContentLabDatabase,
  input: { kind: string; payload: unknown; runAt?: string; maxAttempts?: number; idempotencyKey?: string; syncRemoteId?: string },
): Job {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO jobs(id, kind, payload_json, run_at, max_attempts, idempotency_key, sync_remote_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(id, input.kind, JSON.stringify(input.payload), input.runAt ?? now, input.maxAttempts ?? 3,
    input.idempotencyKey ?? null, input.syncRemoteId ?? null, now, now);
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ? OR (? IS NOT NULL AND idempotency_key = ?) LIMIT 1`)
    .get(id, input.idempotencyKey ?? null, input.idempotencyKey ?? null) as JobRow | undefined;
  if (!row) throw new Error("Unable to enqueue job");
  const job = mapJob(row);
  putSyncEvent(db, "job", job.id, job, now);
  return job;
}

export function leaseJobs(
  db: ContentLabDatabase,
  input: { now?: string; workerId: string; limit?: number; leaseMs?: number },
): Job[] {
  const now = input.now ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  const lockedUntil = new Date(Date.parse(now) + (input.leaseMs ?? 5 * 60_000)).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = (db.prepare(`
      SELECT id FROM jobs
      WHERE run_at <= ? AND (
        status IN ('queued','failed') OR (status = 'running' AND locked_until < ?)
      ) AND attempts < max_attempts
      ORDER BY run_at, created_at LIMIT ?
    `).all(now, now, limit) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) {
      db.exec("COMMIT");
      return [];
    }
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1, locked_until=?, lease_owner=?, updated_at=? WHERE id IN (${placeholders})`)
      .run(lockedUntil, input.workerId, now, ...ids);
    const rows = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders}) ORDER BY run_at, created_at`).all(...ids) as unknown as JobRow[];
    for (const row of rows) putSyncEvent(db, "job", row.id, mapJob(row), now);
    db.exec("COMMIT");
    return rows.map(mapJob);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function completeJob(db: ContentLabDatabase, id: string, now = new Date().toISOString()): void {
  db.prepare("UPDATE jobs SET status='succeeded', locked_until=NULL, lease_owner=NULL, finished_at=?, updated_at=? WHERE id=?")
    .run(now, now, id);
  putSyncEvent(db, "job", id, { id, status: "succeeded", finishedAt: now }, now);
}

export function failJob(db: ContentLabDatabase, id: string, error: unknown, now = new Date().toISOString()): void {
  const row = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id=?").get(id) as { attempts: number; max_attempts: number } | undefined;
  if (!row) throw new Error(`Unknown job ${id}`);
  const terminal = row.attempts >= row.max_attempts;
  const delayMs = Math.min(60 * 60_000, 2 ** Math.max(0, row.attempts - 1) * 60_000);
  const runAt = new Date(Date.parse(now) + delayMs).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare("UPDATE jobs SET status=?, run_at=?, locked_until=NULL, lease_owner=NULL, last_error=?, finished_at=?, updated_at=? WHERE id=?")
    .run(terminal ? "dead" : "failed", runAt, message.slice(0, 2_000), terminal ? now : null, now, id);
  putSyncEvent(db, "job", id, { id, status: terminal ? "dead" : "failed", lastError: message, runAt }, now);
}

export function retryJob(db: ContentLabDatabase, id: string, now = new Date().toISOString()): boolean {
  const result = db.prepare(`
    UPDATE jobs SET status='queued', run_at=?, attempts=0, locked_until=NULL, lease_owner=NULL,
      last_error=NULL, finished_at=NULL, updated_at=?
    WHERE id=? AND kind='analyze' AND status IN ('failed','dead')
  `).run(now, now, id);
  if (result.changes > 0) putSyncEvent(db, "job", id, { id, status: "queued", runAt: now }, now);
  return result.changes > 0;
}

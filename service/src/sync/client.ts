import { readFileSync } from "node:fs";

import type { ContentLabDatabase } from "../db/database.js";
import { syncPostReadModel } from "../collector.js";
import { enqueueJob } from "../jobs/queue.js";

export type RemoteBindJob = {
  id: string;
  kind: "bind";
  payload: { urls: string[]; sitePostId?: string; market?: string | null; projectTag?: string | null; boundBy?: string | null };
  attempts: number;
};

export type RemoteAnalyzeJob = {
  id: string;
  kind: "analyze";
  payload: { postId: string };
  attempts: number;
};

export type RemoteRecreateJob = {
  id: string;
  kind: "recreate";
  /** "copy" reshoots a carousel's photos; "recreate" re-edits with motion graphics. Older Sites send no mode. */
  payload: { recreationId: string; postId: string; mode?: "copy" | "recreate" };
  attempts: number;
};

/** A job this worker cannot run; it is reported back as failed instead of blocking the lease batch. */
export type RemoteRejectedJob = { id: string; kind: "rejected"; reason: string; attempts: number };

export type RemoteJob = RemoteBindJob | RemoteAnalyzeJob | RemoteRecreateJob | RemoteRejectedJob;

/** Hosted analysis retries spend local model quota, so they are budgeted here as well. */
export const REMOTE_ANALYZE_DAILY_LIMIT = 30;
export const REMOTE_ANALYZE_POST_COOLDOWN_MS = 6 * 3_600_000;

export type SiteSyncEvent = {
  id: string;
  type: "post" | "snapshot" | "features" | "prediction" | "job" | "alert" | "playbook" | "post_deleted" | "recreation";
  entityKey: string;
  occurredAt: string;
  payload: unknown;
};

export interface SiteSyncClientOptions {
  baseUrl: string;
  token: string;
  workerId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Outbound-only contract used by the Mac worker:
 * POST /api/local-worker/jobs/lease {workerId,limit,leaseSeconds} -> {jobs: RemoteBindJob[]}
 * POST /api/local-worker/jobs/:id/complete {workerId}
 * POST /api/local-worker/jobs/:id/fail {workerId,error,retryable}
 * POST /api/local-worker/sync {workerId,events: SiteSyncEvent[]} -> {accepted: string[]}
 * Every request uses `Authorization: Bearer SITE_SYNC_TOKEN` and an idempotency key.
 */
export class SiteSyncClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: SiteSyncClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Site sync ${path} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async leaseJobs(limit = 10, leaseSeconds = 300): Promise<RemoteJob[]> {
    const result = await this.post<{ jobs?: unknown }>("/api/local-worker/jobs/lease", { workerId: this.options.workerId, limit, leaseSeconds }, `lease:${this.options.workerId}:${Math.floor(Date.now() / 30_000)}`);
    if (!Array.isArray(result.jobs)) throw new Error("Site sync lease response is missing jobs");
    return result.jobs.flatMap((value): RemoteJob[] => {
      if (!value || typeof value !== "object") return [];
      const job = value as { id?: unknown; kind?: unknown; payload?: Record<string, unknown>; attempts?: unknown };
      if (typeof job.id !== "string") return [];
      const attempts = typeof job.attempts === "number" ? job.attempts : 0;
      const reject = (reason: string): RemoteJob[] => [{ id: job.id as string, kind: "rejected", reason, attempts }];
      if (!job.payload || typeof job.payload !== "object") return reject("Job payload is missing");
      if (job.kind === "bind") {
        if (!Array.isArray(job.payload.urls)) return reject("Bind job has no URL list");
        const sitePostId = job.payload.sitePostId;
        if (sitePostId !== undefined && (typeof sitePostId !== "string" || sitePostId.length < 1 || sitePostId.length > 128)) return reject("Bind job has an invalid sitePostId");
        return [{ id: job.id, kind: "bind", payload: job.payload as RemoteBindJob["payload"], attempts }];
      }
      if (job.kind === "analyze") {
        const postId = job.payload.postId;
        if (typeof postId !== "string" || postId.length < 1 || postId.length > 128) return reject("Analyze job has an invalid postId");
        return [{ id: job.id, kind: "analyze", payload: { postId }, attempts }];
      }
      if (job.kind === "recreate") {
        const { recreationId, postId, mode } = job.payload;
        // The recreation id names a folder the worker deletes and rebuilds: plain tokens only.
        const token = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
        if (!token(recreationId) || !token(postId)) return reject("Recreate job has an invalid recreationId or postId");
        if (mode !== undefined && mode !== "copy" && mode !== "recreate") return reject("Recreate job has an invalid mode");
        return [{ id: job.id, kind: "recreate", payload: { recreationId: recreationId as string, postId: postId as string, ...(mode ? { mode } : {}) }, attempts }];
      }
      return reject(`Unsupported job kind: ${String(job.kind)}`);
    });
  }

  async completeJob(id: string): Promise<void> {
    await this.post(`/api/local-worker/jobs/${encodeURIComponent(id)}/complete`, { workerId: this.options.workerId }, `complete:${id}`);
  }

  async failJob(id: string, error: string, retryable: boolean): Promise<void> {
    await this.post(`/api/local-worker/jobs/${encodeURIComponent(id)}/fail`, { workerId: this.options.workerId, error: error.slice(0, 2_000), retryable }, `fail:${id}:${createErrorKey(error)}`);
  }

  /** PUT a rendered recreation file to the Site's media storage; returns its public path. */
  async uploadRecreationFile(id: string, filename: string, path: string, contentType: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/local-worker/recreations/${encodeURIComponent(id)}/${filename}`, {
        method: "PUT", signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": contentType },
        body: readFileSync(path),
      });
      const payload = await response.json().catch(() => null) as { url?: unknown } | null;
      if (!response.ok || typeof payload?.url !== "string") throw new Error(`Recreation upload returned ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
      return payload.url;
    } finally {
      clearTimeout(timer);
    }
  }

  async pushEvents(events: SiteSyncEvent[]): Promise<string[]> {
    if (events.length === 0) return [];
    const result = await this.post<{ accepted?: unknown; ignored?: unknown }>("/api/local-worker/sync", { workerId: this.options.workerId, events }, `sync:${events.map((event) => event.id).join(",")}`);
    if (!Array.isArray(result.accepted) || result.accepted.some((id) => typeof id !== "string")) throw new Error("Site sync response is missing accepted event ids");
    if (result.ignored !== undefined && (!Array.isArray(result.ignored) || result.ignored.some((id) => typeof id !== "string"))) throw new Error("Site sync response has invalid duplicate event ids");
    // An acknowledged duplicate was already committed by the Site, often before
    // a previous HTTP response was lost. It must leave the local retry outbox too.
    return [...new Set([...(result.accepted as string[]), ...((result.ignored ?? []) as string[])])];
  }
}

const createErrorKey = (error: string): string => {
  let hash = 2166136261;
  for (const char of error) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
};

function analyzeBudgetRefusal(db: ContentLabDatabase, sitePostId: string, now: number): string | null {
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const daily = (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='remote_analyze' AND created_at >= ?").get(since) as { count: number }).count;
  if (daily >= REMOTE_ANALYZE_DAILY_LIMIT) return `已達每日 ${REMOTE_ANALYZE_DAILY_LIMIT} 次重新分析上限`;
  const cooldownStart = new Date(now - REMOTE_ANALYZE_POST_COOLDOWN_MS).toISOString();
  const recent = db.prepare("SELECT 1 FROM jobs WHERE kind='remote_analyze' AND json_extract(payload_json, '$.sitePostId')=? AND created_at >= ? LIMIT 1").get(sitePostId, cooldownStart);
  return recent ? "這條帖子 6 小時內已重新分析過" : null;
}

export async function pullRemoteJobs(db: ContentLabDatabase, client: SiteSyncClient, now = Date.now()): Promise<number> {
  const jobs = await client.leaseJobs();
  let accepted = 0;
  for (const job of jobs) {
    let refusal: string | null = job.kind === "rejected" ? job.reason : null;
    if (job.kind === "analyze") refusal = analyzeBudgetRefusal(db, job.payload.postId, now);
    if (refusal) {
      await client.failJob(job.id, refusal, false).catch(() => undefined);
      // The Site marked the post as queued when the retry was requested; restore its real state.
      const post = job.kind === "analyze"
        ? db.prepare("SELECT id FROM posts WHERE site_post_id=? OR id=? LIMIT 1").get(job.payload.postId, job.payload.postId) as { id: string } | undefined
        : undefined;
      if (post) syncPostReadModel(db, post.id);
      continue;
    }
    if (job.kind === "bind") {
      enqueueJob(db, { kind: "remote_bind", payload: job.payload, syncRemoteId: job.id, idempotencyKey: `site-job:${job.id}`, maxAttempts: 3 });
    } else if (job.kind === "analyze") {
      enqueueJob(db, { kind: "remote_analyze", payload: { sitePostId: job.payload.postId }, syncRemoteId: job.id, idempotencyKey: `site-job:${job.id}`, maxAttempts: 3 });
    } else if (job.kind === "recreate") {
      // Progress travels on the recreation row, so the Site job is done once the work is queued here.
      enqueueJob(db, { kind: "recreate", payload: { recreationId: job.payload.recreationId, sitePostId: job.payload.postId, ...(job.payload.mode ? { mode: job.payload.mode } : {}) }, idempotencyKey: `site-job:${job.id}`, maxAttempts: 2 });
      await client.completeJob(job.id);
    }
    accepted += 1;
  }
  return accepted;
}

interface OutboxRow {
  id: string; type: SiteSyncEvent["type"]; entity_key: string; occurred_at: string; payload_json: string; attempts: number;
}

/** `includeDeletes` stays off until the Site accepts post_deleted events; an older Site rejects the whole batch. */
export async function flushSyncOutbox(db: ContentLabDatabase, client: SiteSyncClient, limit = 50, options: { includeDeletes?: boolean } = {}): Promise<number> {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, type, entity_key, occurred_at, payload_json, attempts FROM sync_outbox
    WHERE next_attempt_at <= ? AND (type != 'post_deleted' OR ?) ORDER BY occurred_at LIMIT ?
  `).all(now, options.includeDeletes ? 1 : 0, Math.max(1, Math.min(limit, 50))) as unknown as OutboxRow[];
  if (rows.length === 0) return 0;
  const events: SiteSyncEvent[] = rows.map((row) => ({ id: row.id, type: row.type, entityKey: row.entity_key, occurredAt: row.occurred_at, payload: JSON.parse(row.payload_json) as unknown }));
  try {
    const accepted = new Set(await client.pushEvents(events));
    const remove = db.prepare("DELETE FROM sync_outbox WHERE id=?");
    for (const row of rows) if (accepted.has(row.id)) remove.run(row.id);
    return accepted.size;
  } catch (error) {
    const statement = db.prepare("UPDATE sync_outbox SET attempts=attempts+1, next_attempt_at=?, last_error=? WHERE id=?");
    for (const row of rows) {
      const delay = Math.min(60 * 60_000, 2 ** Math.min(row.attempts, 6) * 30_000);
      statement.run(new Date(Date.now() + delay).toISOString(), error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000), row.id);
    }
    throw error;
  }
}

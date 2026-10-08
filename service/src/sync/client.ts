import type { ContentLabDatabase } from "../db/database.js";
import { enqueueJob } from "../jobs/queue.js";

export type RemoteBindJob = {
  id: string;
  kind: "bind";
  payload: { urls: string[]; sitePostId?: string; market?: string | null; projectTag?: string | null; boundBy?: string | null };
  attempts: number;
};

export type SiteSyncEvent = {
  id: string;
  type: "post" | "snapshot" | "features" | "prediction" | "job" | "alert";
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

  async leaseJobs(limit = 10, leaseSeconds = 300): Promise<RemoteBindJob[]> {
    const result = await this.post<{ jobs?: unknown }>("/api/local-worker/jobs/lease", { workerId: this.options.workerId, limit, leaseSeconds }, `lease:${this.options.workerId}:${Math.floor(Date.now() / 30_000)}`);
    if (!Array.isArray(result.jobs)) throw new Error("Site sync lease response is missing jobs");
    return result.jobs.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Site sync returned an invalid job");
      const job = value as Partial<RemoteBindJob>;
      if (typeof job.id !== "string" || job.kind !== "bind" || !job.payload || !Array.isArray(job.payload.urls)) throw new Error("Site sync returned an unsupported job");
      if (job.payload.sitePostId !== undefined && (typeof job.payload.sitePostId !== "string" || job.payload.sitePostId.length < 1 || job.payload.sitePostId.length > 128)) throw new Error("Site sync returned an invalid sitePostId");
      return { id: job.id, kind: "bind", payload: job.payload, attempts: typeof job.attempts === "number" ? job.attempts : 0 };
    });
  }

  async completeJob(id: string): Promise<void> {
    await this.post(`/api/local-worker/jobs/${encodeURIComponent(id)}/complete`, { workerId: this.options.workerId }, `complete:${id}`);
  }

  async failJob(id: string, error: string, retryable: boolean): Promise<void> {
    await this.post(`/api/local-worker/jobs/${encodeURIComponent(id)}/fail`, { workerId: this.options.workerId, error: error.slice(0, 2_000), retryable }, `fail:${id}:${createErrorKey(error)}`);
  }

  async pushEvents(events: SiteSyncEvent[]): Promise<string[]> {
    if (events.length === 0) return [];
    const result = await this.post<{ accepted?: unknown }>("/api/local-worker/sync", { workerId: this.options.workerId, events }, `sync:${events.map((event) => event.id).join(",")}`);
    if (!Array.isArray(result.accepted) || result.accepted.some((id) => typeof id !== "string")) throw new Error("Site sync response is missing accepted event ids");
    return result.accepted as string[];
  }
}

const createErrorKey = (error: string): string => {
  let hash = 2166136261;
  for (const char of error) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
};

export async function pullRemoteJobs(db: ContentLabDatabase, client: SiteSyncClient): Promise<number> {
  const jobs = await client.leaseJobs();
  for (const job of jobs) {
    enqueueJob(db, {
      kind: "remote_bind", payload: job.payload, syncRemoteId: job.id,
      idempotencyKey: `site-job:${job.id}`, maxAttempts: 3,
    });
  }
  return jobs.length;
}

interface OutboxRow {
  id: string; type: SiteSyncEvent["type"]; entity_key: string; occurred_at: string; payload_json: string; attempts: number;
}

export async function flushSyncOutbox(db: ContentLabDatabase, client: SiteSyncClient, limit = 100): Promise<number> {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, type, entity_key, occurred_at, payload_json, attempts FROM sync_outbox
    WHERE next_attempt_at <= ? ORDER BY occurred_at LIMIT ?
  `).all(now, Math.max(1, Math.min(limit, 500))) as unknown as OutboxRow[];
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

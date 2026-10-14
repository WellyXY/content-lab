import { createHash, randomUUID } from "node:crypto";

import type { ServiceConfig } from "./config.js";
import type { ContentLabDatabase } from "./db/database.js";
import { extractVideoId } from "./domain/tiktok-url.js";
import { enqueueJob } from "./jobs/queue.js";
import { putSyncEvent } from "./sync/outbox.js";

export type BindLimits = Pick<ServiceConfig, "dailyNewPosts" | "maxActivePosts">;

export interface BindInput {
  /** Already normalized with normalizeTikTokUrl. */
  urls: string[];
  market: string | null;
  projectTag: string | null;
  boundBy: string;
  /** An extra per-caller budget, e.g. the website's hourly limit per IP. */
  callerBudget?: { key: string; limit: number; windowMs: number };
}

export type BindResult =
  | { ok: true; jobs: Array<{ id: string; status: string; url: string }>; alreadyTracked: Array<{ url: string; postId: string }> }
  | { ok: false; error: "rate_limited" | "daily_quota_exceeded" | "active_post_quota_exceeded"; limit: number };

export function consumeBudget(db: ContentLabDatabase, key: string, units: number, limit: number, windowMs: number, now: Date): boolean {
  const existing = db.prepare("SELECT window_started_at, count FROM rate_limits WHERE key=?").get(key) as { window_started_at: string; count: number } | undefined;
  const expired = !existing || Date.parse(existing.window_started_at) + windowMs <= now.getTime();
  const count = expired ? 0 : existing.count;
  if (count + units > limit) return false;
  db.prepare(`
    INSERT INTO rate_limits(key, window_started_at, count, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET window_started_at=excluded.window_started_at, count=excluded.count, updated_at=excluded.updated_at
  `).run(key, expired ? now.toISOString() : existing.window_started_at, count + units, now.toISOString());
  return true;
}

function recordQuotaAlert(db: ContentLabDatabase, kind: string, payload: unknown, now: Date): void {
  const id = randomUUID();
  const bucket = now.toISOString().slice(0, 13);
  const firedAt = now.toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO alerts(id, post_id, rule, dedupe_key, fired_at, payload_json, next_delivery_at)
    VALUES (?, NULL, 'ops_quota', ?, ?, ?, ?)
  `).run(id, `ops:quota:${kind}:${bucket}`, firedAt, JSON.stringify(payload), firedAt);
  if (result.changes > 0) putSyncEvent(db, "alert", id, { id, postId: null, rule: "ops_quota", firedAt, payload, deliveredAt: null }, firedAt);
}

/** Queue ingest jobs for new TikTok URLs under the shared daily and active-post quotas. */
export function bindPosts(db: ContentLabDatabase, limits: BindLimits, input: BindInput, now = new Date()): BindResult {
  const urls = [...new Set(input.urls)];
  const alreadyTracked: Array<{ url: string; postId: string }> = [];
  const fresh: string[] = [];
  for (const url of urls) {
    const videoId = extractVideoId(url);
    const row = db.prepare("SELECT id FROM posts WHERE url=? OR (? IS NOT NULL AND video_id=?) LIMIT 1").get(url, videoId, videoId) as { id: string } | undefined;
    if (row) alreadyTracked.push({ url, postId: row.id });
    else fresh.push(url);
  }
  if (fresh.length === 0) return { ok: true, jobs: [], alreadyTracked };
  db.exec("BEGIN IMMEDIATE");
  try {
    const budget = input.callerBudget;
    if (budget && !consumeBudget(db, budget.key, fresh.length, budget.limit, budget.windowMs, now)) {
      db.exec("ROLLBACK");
      return { ok: false, error: "rate_limited", limit: budget.limit };
    }
    if (!consumeBudget(db, "bind-global", fresh.length, limits.dailyNewPosts, 24 * 60 * 60_000, now)) {
      db.exec("ROLLBACK");
      recordQuotaAlert(db, "daily", { requested: fresh.length, limit: limits.dailyNewPosts }, now);
      return { ok: false, error: "daily_quota_exceeded", limit: limits.dailyNewPosts };
    }
    const active = (db.prepare("SELECT COUNT(*) AS count FROM posts WHERE tracking_state != 'stopped'").get() as { count: number }).count;
    const pending = (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='ingest' AND status IN ('queued','running','failed')").get() as { count: number }).count;
    if (active + pending + fresh.length > limits.maxActivePosts) {
      db.exec("ROLLBACK");
      recordQuotaAlert(db, "active", { active, pending, requested: fresh.length, limit: limits.maxActivePosts }, now);
      return { ok: false, error: "active_post_quota_exceeded", limit: limits.maxActivePosts };
    }
    const jobs = fresh.map((url) => enqueueJob(db, {
      kind: "ingest",
      payload: { url, market: input.market, projectTag: input.projectTag, boundBy: input.boundBy },
      idempotencyKey: `ingest:${createHash("sha256").update(url).digest("hex")}`,
    }));
    db.exec("COMMIT");
    return { ok: true, jobs: jobs.map((job) => ({ id: job.id, status: job.status, url: (job.payload as { url: string }).url })), alreadyTracked };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const DAILY_WINDOW_MS = 24 * 60 * 60_000;

/** New posts that can still be bound in the current rolling day. */
export function remainingDailyQuota(db: ContentLabDatabase, limits: BindLimits, now = new Date()): number {
  const row = db.prepare("SELECT window_started_at, count FROM rate_limits WHERE key='bind-global'").get() as { window_started_at: string; count: number } | undefined;
  if (!row || Date.parse(row.window_started_at) + DAILY_WINDOW_MS <= now.getTime()) return limits.dailyNewPosts;
  return Math.max(0, limits.dailyNewPosts - row.count);
}

/** Keep links that did not fit today's quota; they are bound in order as the quota frees up. Returns how many were new. */
export function deferBinds(db: ContentLabDatabase, entries: Array<{ url: string; market: string }>, boundBy: string, now = new Date()): number {
  const insert = db.prepare("INSERT OR IGNORE INTO pending_binds(url, market, bound_by, created_at) VALUES (?, ?, ?, ?)");
  let added = 0;
  for (const entry of entries) added += Number(insert.run(entry.url, entry.market, boundBy, now.toISOString()).changes);
  return added;
}

export function pendingBindCounts(db: ContentLabDatabase): Record<string, number> {
  return Object.fromEntries((db.prepare("SELECT market, COUNT(*) AS n FROM pending_binds GROUP BY market ORDER BY market").all() as Array<{ market: string; n: number }>).map((row) => [row.market, row.n]));
}

/** Bind the oldest waiting links that fit the quota left today; already-tracked ones are dropped without using quota. */
export function drainPendingBinds(db: ContentLabDatabase, limits: BindLimits, now = new Date()): { queued: number; remaining: number } {
  let queued = 0;
  const left = remainingDailyQuota(db, limits, now);
  if (left > 0) {
    const rows = db.prepare("SELECT url, market, bound_by FROM pending_binds ORDER BY created_at, rowid LIMIT ?").all(left) as Array<{ url: string; market: string; bound_by: string | null }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) groups.set(`${row.market}|${row.bound_by ?? ""}`, [...(groups.get(`${row.market}|${row.bound_by ?? ""}`) ?? []), row]);
    const remove = db.prepare("DELETE FROM pending_binds WHERE url=?");
    for (const group of groups.values()) {
      const result = bindPosts(db, limits, { urls: group.map((row) => row.url), market: group[0]!.market, projectTag: null, boundBy: group[0]!.bound_by ?? "pending" }, now);
      if (!result.ok) break;
      queued += result.jobs.length;
      for (const row of group) remove.run(row.url);
    }
  }
  return { queued, remaining: (db.prepare("SELECT COUNT(*) AS n FROM pending_binds").get() as { n: number }).n };
}

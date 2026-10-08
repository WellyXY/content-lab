import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { Hono, type Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import type { ServiceConfig } from "./config.js";
import { syncPostReadModel } from "./collector.js";
import type { ContentLabDatabase } from "./db/database.js";
import { normalizeTikTokUrl } from "./domain/tiktok-url.js";
import { enqueueJob, retryJob } from "./jobs/queue.js";
import { putSyncEvent } from "./sync/outbox.js";

export type PublicAppConfig = Pick<ServiceConfig, "bindHourlyPerIp" | "dailyNewPosts" | "maxActivePosts" | "bindSecret" | "turnstileSecret">
  & Partial<Pick<ServiceConfig, "analysisRetryHourlyPerIp" | "mediaDir">>;

const bindBody = z.object({
  urls: z.array(z.string().min(1)).min(1).max(50),
  market: z.string().trim().min(2).max(16).optional(),
  projectTag: z.string().trim().max(100).optional(),
  boundBy: z.string().trim().max(100).optional(),
  bindSecret: z.string().optional(),
  turnstileToken: z.string().optional(),
}).strict();

function consumeBudget(db: ContentLabDatabase, key: string, units: number, limit: number, windowMs: number, now: Date): boolean {
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

async function verifyTurnstile(secret: string, token: string | undefined, ip: string): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: controller.signal });
    const result = await response.json() as { success?: boolean };
    return response.ok && result.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
};

function serializePost(row: Record<string, unknown>): Record<string, unknown> {
  const output = { ...row };
  for (const key of ["tags", "keyframes", "analysis", "inputs", "payload"] as const) {
    if (key in output) output[key] = json(output[key]);
  }
  return output;
}

export function createApp(input: { db: ContentLabDatabase; config: PublicAppConfig }): Hono {
  const { db, config } = input;
  const app = new Hono();
  app.use("*", secureHeaders());
  app.use("/api/posts/bind", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request_too_large" }, 413) }));
  app.use("/api/posts", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request_too_large" }, 413) }));

  app.onError((error, c) => {
    console.error(JSON.stringify({ level: "error", event: "http_error", message: error.message, path: c.req.path }));
    return c.json({ error: "internal_error", requestId: c.get("requestId" as never) ?? null }, 500);
  });

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    c.header("x-request-id", requestId);
    await next();
  });

  app.get("/health", (c) => {
    const migration = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    const lastScan = db.prepare("SELECT value FROM scheduler_state WHERE key='last_scan_at'").get() as { value: string } | undefined;
    const queue = db.prepare("SELECT SUM(CASE WHEN status IN ('queued','running','failed') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead FROM jobs").get() as { pending: number | null; dead: number | null };
    const latest = db.prepare("SELECT MAX(captured_at) AS value FROM metric_snapshots WHERE ok=1").get() as { value: string | null };
    return c.json({
      ok: true, service: "content-lab", database: "ok", schemaVersion: migration.version,
      worker: { lastScanAt: lastScan?.value ?? null }, queue: { pending: queue.pending ?? 0, dead: queue.dead ?? 0 },
      latestSnapshotAt: latest.value, time: new Date().toISOString(),
    });
  });

  const handleBind: Handler = async (c) => {
    const parsed = bindBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    if (config.bindSecret && parsed.data.bindSecret !== config.bindSecret && c.req.header("x-bind-secret") !== config.bindSecret) {
      return c.json({ error: "invalid_bind_secret" }, 403);
    }
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (config.turnstileSecret && !(await verifyTurnstile(config.turnstileSecret, parsed.data.turnstileToken, ip))) {
      return c.json({ error: "turnstile_failed" }, 403);
    }
    let urls: string[];
    try {
      urls = [...new Set(parsed.data.urls.map(normalizeTikTokUrl))];
    } catch (error) {
      return c.json({ error: "invalid_tiktok_url", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    const now = new Date();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!consumeBudget(db, `bind-ip:${ip}`, urls.length, config.bindHourlyPerIp, 60 * 60_000, now)) {
        db.exec("ROLLBACK");
        c.header("retry-after", "3600");
        return c.json({ error: "rate_limited", limit: config.bindHourlyPerIp }, 429);
      }
      if (!consumeBudget(db, "bind-global", urls.length, config.dailyNewPosts, 24 * 60 * 60_000, now)) {
        db.exec("ROLLBACK");
        recordQuotaAlert(db, "daily", { requested: urls.length, limit: config.dailyNewPosts }, now);
        return c.json({ error: "daily_quota_exceeded", limit: config.dailyNewPosts }, 429);
      }
      const active = (db.prepare("SELECT COUNT(*) AS count FROM posts WHERE tracking_state != 'stopped'").get() as { count: number }).count;
      const pending = (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='ingest' AND status IN ('queued','running','failed')").get() as { count: number }).count;
      if (active + pending + urls.length > config.maxActivePosts) {
        db.exec("ROLLBACK");
        recordQuotaAlert(db, "active", { active, pending, requested: urls.length, limit: config.maxActivePosts }, now);
        return c.json({ error: "active_post_quota_exceeded", limit: config.maxActivePosts }, 409);
      }
      const jobs = urls.map((url) => enqueueJob(db, {
        kind: "ingest",
        payload: { url, market: parsed.data.market ?? null, projectTag: parsed.data.projectTag ?? null, boundBy: parsed.data.boundBy ?? ip },
        idempotencyKey: `ingest:${createHash("sha256").update(url).digest("hex")}`,
      }));
      db.exec("COMMIT");
      return c.json({ accepted: urls.length, jobs: jobs.map((job) => ({ id: job.id, status: job.status, url: (job.payload as { url?: string }).url })) }, 202);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  app.post("/api/posts/bind", handleBind);
  app.post("/api/posts", handleBind);

  app.get("/media/:postId/:file", async (c) => {
    if (!config.mediaDir) return c.json({ error: "not_found" }, 404);
    const postId = c.req.param("postId");
    const filename = c.req.param("file");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(postId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(filename)) return c.json({ error: "not_found" }, 404);
    const extension = extname(filename).toLowerCase();
    const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg" : null;
    if (!mime) return c.json({ error: "not_found" }, 404);
    const root = resolve(config.mediaDir);
    const target = resolve(root, postId, filename);
    if (!target.startsWith(`${root}${sep}`)) return c.json({ error: "not_found" }, 404);
    try {
      const data = await readFile(target);
      c.header("content-type", mime);
      c.header("cache-control", "public, max-age=86400, immutable");
      return c.body(new Uint8Array(data));
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.get("/api/overview", (c) => {
    const now = Date.now();
    const currentStart = new Date(now - 7 * 86_400_000).toISOString();
    const previousStart = new Date(now - 14 * 86_400_000).toISOString();
    const dayStart = new Date(now - 24 * 3_600_000).toISOString();
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN hour_bucket >= ? THEN views_delta END),0) AS current,
        COALESCE(SUM(CASE WHEN hour_bucket >= ? AND hour_bucket < ? THEN views_delta END),0) AS previous
      FROM post_hourly WHERE views_delta IS NOT NULL
    `).get(currentStart, previousStart, currentStart) as { current: number; previous: number };
    const activePosts = (db.prepare("SELECT COUNT(*) AS count FROM posts WHERE tracking_state != 'stopped'").get() as { count: number }).count;
    const weeklyHits = (db.prepare(`
      SELECT COUNT(*) AS count FROM posts p WHERE p.published_at >= ? AND
      COALESCE((SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1),0) >= 1000000
    `).get(currentStart) as { count: number }).count;
    const topMovers = db.prepare(`
      SELECT p.id, p.video_id AS videoId, p.url, p.market, p.caption,
             COALESCE(SUM(h.views_delta),0) AS viewsDelta24h
      FROM posts p JOIN post_hourly h ON h.post_id=p.id AND h.hour_bucket >= ?
      GROUP BY p.id ORDER BY viewsDelta24h DESC LIMIT 10
    `).all(dayStart);
    const alerts = (db.prepare(`SELECT id, post_id AS postId, rule, fired_at AS firedAt, payload_json AS payload, delivered_at AS deliveredAt FROM alerts ORDER BY fired_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>).map(serializePost);
    const change = totals.previous === 0 ? null : (totals.current - totals.previous) / totals.previous;
    return c.json({ sevenDayViews: { current: totals.current, previous: totals.previous, change }, activePosts, weeklyHits, topMovers, recentAlerts: alerts });
  });

  app.get("/api/posts", (c) => {
    const market = c.req.query("market")?.trim();
    const projectTag = c.req.query("projectTag")?.trim();
    const state = c.req.query("state")?.trim();
    const creator = c.req.query("creator")?.trim();
    const tag = c.req.query("tag")?.trim();
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(c.req.query("offset") || "0", 10) || 0, 0);
    const dayStart = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const sortMap: Record<string, string> = { views24h: "viewsDelta24h", views: "views", boundAt: "p.bound_at" };
    const orderBy = sortMap[c.req.query("sort") || ""] ?? "p.bound_at";
    const direction = c.req.query("direction") === "asc" ? "ASC" : "DESC";
    const conditions: string[] = ["1=1"];
    const values: Array<string | number> = [];
    if (market) { conditions.push("p.market=?"); values.push(market); }
    if (projectTag) { conditions.push("p.project_tag=?"); values.push(projectTag); }
    if (state) { conditions.push("p.tracking_state=?"); values.push(state); }
    if (creator) { conditions.push("c.handle LIKE ? ESCAPE '\\'"); values.push(`%${creator.replace(/[\\%_]/g, "\\$&")}%`); }
    if (tag) { conditions.push("instr(f.tags_json, ?) > 0"); values.push(`\"${tag}\"`); }
    const rows = db.prepare(`
      SELECT p.id, p.video_id AS videoId, p.url, p.market, p.project_tag AS projectTag,
             p.type, p.duration_s AS durationS, p.caption, p.cover_url AS coverUrl,
             p.published_at AS publishedAt, p.bound_at AS boundAt, p.tracking_state AS trackingState,
             p.features_state AS featuresState, c.handle AS creator,
             COALESCE((SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1),0) AS views,
             COALESCE((SELECT SUM(views_delta) FROM post_hourly h WHERE h.post_id=p.id AND h.hour_bucket >= ?),0) AS viewsDelta24h,
             f.tags_json AS tags
      FROM posts p LEFT JOIN creators c ON c.id=p.creator_id
      LEFT JOIN post_features f ON f.post_id=p.id AND f.version=(SELECT MAX(version) FROM post_features WHERE post_id=p.id)
      WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?
    `).all(dayStart, ...values, limit, offset) as Array<Record<string, unknown>>;
    const total = (db.prepare(`SELECT COUNT(DISTINCT p.id) AS count FROM posts p LEFT JOIN creators c ON c.id=p.creator_id LEFT JOIN post_features f ON f.post_id=p.id AND f.version=(SELECT MAX(f2.version) FROM post_features f2 WHERE f2.post_id=p.id) WHERE ${conditions.join(" AND ")}`).get(...values) as { count: number }).count;
    return c.json({ posts: rows.map(serializePost), total, limit, offset });
  });

  app.get("/api/posts/:id", (c) => {
    const post = db.prepare(`
      SELECT p.*, c.handle AS creator FROM posts p LEFT JOIN creators c ON c.id=p.creator_id WHERE p.id=?
    `).get(c.req.param("id")) as Record<string, unknown> | undefined;
    if (!post) return c.json({ error: "not_found" }, 404);
    const id = c.req.param("id");
    const hourly = db.prepare("SELECT hour_bucket AS hourBucket, views_cum AS viewsCum, views_delta AS viewsDelta, likes_delta AS likesDelta, comments_delta AS commentsDelta, shares_delta AS sharesDelta, saves_delta AS savesDelta, coverage FROM post_hourly WHERE post_id=? ORDER BY hour_bucket").all(id);
    const snapshots = db.prepare("SELECT captured_at AS capturedAt, views, likes, comments, shares, saves, source, ok, error FROM metric_snapshots WHERE post_id=? ORDER BY captured_at").all(id);
    const features = (db.prepare("SELECT version, model, taxonomy_version AS taxonomyVersion, tags_json AS tags, hook_text AS hookText, transcript, summary_zh AS summaryZh, keyframes_json AS keyframes, analysis_json AS analysis, created_at AS createdAt FROM post_features WHERE post_id=? ORDER BY version DESC").all(id) as Array<Record<string, unknown>>).map(serializePost);
    const predictions = (db.prepare("SELECT id, stage, made_at AS madeAt, rank_value AS rank, cohort_size AS cohortSize, band, model_version AS modelVersion, rationale, inputs_json AS inputs FROM predictions WHERE post_id=? ORDER BY made_at DESC").all(id) as Array<Record<string, unknown>>).map(serializePost);
    const alerts = (db.prepare("SELECT id, rule, fired_at AS firedAt, payload_json AS payload, delivered_at AS deliveredAt, delivery_error AS deliveryError FROM alerts WHERE post_id=? ORDER BY fired_at DESC").all(id) as Array<Record<string, unknown>>).map(serializePost);
    return c.json({ post, hourly, snapshots, features, predictions, alerts });
  });

  app.get("/api/jobs", (c) => {
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") || "100", 10) || 100, 1), 200);
    const rows = (db.prepare("SELECT id, kind, payload_json AS payload, status, run_at AS runAt, attempts, max_attempts AS maxAttempts, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(serializePost);
    return c.json({ jobs: rows });
  });

  app.post("/api/jobs/:id/retry", (c) => {
    const id = c.req.param("id");
    const candidate = db.prepare("SELECT payload_json FROM jobs WHERE id=? AND kind='analyze' AND status IN ('failed','dead')").get(id) as { payload_json: string } | undefined;
    if (!candidate) return c.json({ error: "job_not_retryable" }, 409);
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = new Date();
    if (!consumeBudget(db, `analysis-retry-ip:${ip}`, 1, config.analysisRetryHourlyPerIp ?? 10, 60 * 60_000, now)) {
      c.header("retry-after", "3600");
      return c.json({ error: "rate_limited", limit: config.analysisRetryHourlyPerIp ?? 10 }, 429);
    }
    if (!retryJob(db, id, now.toISOString())) return c.json({ error: "job_not_retryable" }, 409);
    const payload = JSON.parse(candidate.payload_json) as { postId?: string };
    if (payload.postId) {
      db.prepare("UPDATE posts SET features_state='pending', updated_at=? WHERE id=?").run(now.toISOString(), payload.postId);
      syncPostReadModel(db, payload.postId, now.toISOString());
    }
    return c.json({ ok: true, id });
  });

  return app;
}

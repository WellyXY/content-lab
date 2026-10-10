import { createHash, randomUUID } from "node:crypto";

import type { ContentLabDatabase } from "./db/database.js";
import { evaluateAlerts } from "./domain/alerts.js";
import { deriveCheckpoints, type CheckpointSnapshot } from "./domain/checkpoints.js";
import { MARKET_UTC_OFFSET_HOURS } from "./domain/features.js";
import { deriveHourlyRows, hourBucket, type MetricPoint } from "./domain/hourly.js";
import { nextCaptureAt } from "./domain/schedule.js";
import { enqueueJob } from "./jobs/queue.js";
import type { MetricsProvider, PostMetadata, PostMetrics, ProviderResult } from "./providers/metrics.js";
import { ProviderError } from "./providers/metrics.js";
import { putSyncEvent } from "./sync/outbox.js";

interface PostRow {
  id: string; site_post_id: string | null; video_id: string; url: string; market: string | null; project_tag: string | null;
  published_at: string | null; bound_at: string; tracking_state: string; next_capture_at: string | null;
}

export const postReadModel = (db: ContentLabDatabase, id: string): Record<string, unknown> => {
  const row = db.prepare(`
    SELECT COALESCE(p.site_post_id,p.id) AS id, p.id AS localPostId, p.site_post_id AS sitePostId,
      p.video_id AS videoId, p.url, p.market, p.project_tag AS projectTag,
      p.type, p.duration_s AS durationS, p.caption, p.music_title AS musicTitle,
      p.cover_url AS coverUrl, p.media_url AS mediaUrl, p.published_at AS publishedAt, p.bound_at AS boundAt,
      p.bound_by AS boundBy,
      p.tracking_state AS trackingState, p.next_capture_at AS nextCaptureAt,
      p.features_state AS featuresState, p.checkpoints_json AS checkpointsJson, p.ads_json AS adsJson, c.handle AS creator
    FROM posts p LEFT JOIN creators c ON c.id=p.creator_id WHERE p.id=?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Unknown post ${id}`);
  const { checkpointsJson, adsJson, ...model } = row;
  return {
    ...model,
    checkpoints: typeof checkpointsJson === "string" ? JSON.parse(checkpointsJson) as unknown : [],
    // Spark Ads delivery totals, refreshed by the ads sync; null when the post was never promoted.
    ads: typeof adsJson === "string" ? JSON.parse(adsJson) as unknown : null,
  };
};

/** Recompute the early-performance checkpoints from every successful snapshot of the post. */
export function refreshCheckpoints(db: ContentLabDatabase, postId: string, now = new Date().toISOString()): void {
  const post = db.prepare("SELECT published_at FROM posts WHERE id=?").get(postId) as { published_at: string | null } | undefined;
  if (!post) return;
  const snapshots = db.prepare(`SELECT captured_at AS capturedAt, views, likes, comments, shares, saves FROM metric_snapshots
    WHERE post_id=? AND ok=1 AND views IS NOT NULL ORDER BY captured_at`).all(postId) as unknown as CheckpointSnapshot[];
  db.prepare("UPDATE posts SET checkpoints_json=? WHERE id=?").run(JSON.stringify(deriveCheckpoints(post.published_at, snapshots, Date.parse(now))), postId);
}

export function syncPostReadModel(db: ContentLabDatabase, id: string, now = new Date().toISOString()): void {
  const model = postReadModel(db, id);
  putSyncEvent(db, "post", String(model.sitePostId ?? model.id), model, now);
}

function upsertCreator(db: ContentLabDatabase, metadata: PostMetadata, now: string): string {
  const existing = metadata.authorId
    ? db.prepare("SELECT id FROM creators WHERE platform_user_id=?").get(metadata.authorId) as { id: string } | undefined
    : db.prepare("SELECT id FROM creators WHERE handle=? ORDER BY created_at LIMIT 1").get(metadata.authorHandle) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE creators SET handle=? WHERE id=?").run(metadata.authorHandle, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO creators(id, handle, platform_user_id, created_at) VALUES (?, ?, ?, ?)")
    .run(id, metadata.authorHandle, metadata.authorId, now);
  return id;
}

export function upsertPost(
  db: ContentLabDatabase,
  result: ProviderResult,
  binding: { market: string | null; projectTag: string | null; boundBy: string | null; sitePostId?: string | null },
  now = new Date().toISOString(),
): PostRow {
  const creatorId = upsertCreator(db, result.metadata, now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO posts(
      id, site_post_id, video_id, url, creator_id, market, project_tag, type, duration_s, caption, music_title,
      cover_url, media_url, image_urls_json, published_at, bound_at, bound_by, next_capture_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      site_post_id=COALESCE(posts.site_post_id, excluded.site_post_id),
      url=excluded.url, creator_id=excluded.creator_id, market=COALESCE(posts.market, excluded.market),
      project_tag=COALESCE(posts.project_tag, excluded.project_tag), type=excluded.type,
      duration_s=COALESCE(excluded.duration_s, posts.duration_s), caption=excluded.caption,
      music_title=COALESCE(excluded.music_title, posts.music_title), cover_url=COALESCE(excluded.cover_url, posts.cover_url),
      media_url=COALESCE(excluded.media_url, posts.media_url),
      image_urls_json=CASE WHEN excluded.image_urls_json IS NULL THEN posts.image_urls_json ELSE excluded.image_urls_json END,
      published_at=COALESCE(excluded.published_at, posts.published_at),
      updated_at=excluded.updated_at
  `).run(
    id, binding.sitePostId ?? null, result.metadata.videoId, result.metadata.url, creatorId, binding.market, binding.projectTag,
    result.metadata.type, result.metadata.durationS, result.metadata.caption, result.metadata.musicTitle,
    result.metadata.coverUrl, result.metadata.mediaUrl,
    result.metadata.imageUrls?.length ? JSON.stringify(result.metadata.imageUrls) : null,
    result.metadata.publishedAt, now, binding.boundBy,
    now, now, now,
  );
  const row = db.prepare("SELECT * FROM posts WHERE video_id=?").get(result.metadata.videoId) as unknown as PostRow;
  syncPostReadModel(db, row.id, now);
  return row;
}

function insertAlert(
  db: ContentLabDatabase,
  input: { postId: string | null; rule: string; dedupeKey: string; payload: unknown },
  now: string,
): boolean {
  const id = randomUUID();
  const result = db.prepare(`
    INSERT OR IGNORE INTO alerts(id, post_id, rule, dedupe_key, fired_at, payload_json, next_delivery_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.postId, input.rule, input.dedupeKey, now, JSON.stringify(input.payload), now);
  if (result.changes > 0) {
    const mapping = input.postId
      ? db.prepare("SELECT site_post_id FROM posts WHERE id=?").get(input.postId) as { site_post_id: string | null } | undefined
      : undefined;
    putSyncEvent(db, "alert", id, {
      id, postId: mapping?.site_post_id ?? input.postId, sitePostId: mapping?.site_post_id ?? null,
      localPostId: input.postId, rule: input.rule, firedAt: now, payload: input.payload, deliveredAt: null,
    }, now);
    return true;
  }
  return false;
}

function scheduleNextCapture(db: ContentLabDatabase, post: PostRow, metrics: PostMetrics, now: string): void {
  const recent = db.prepare(`
    SELECT COALESCE(SUM(views_delta),0) AS delta FROM post_hourly
    WHERE post_id=? AND hour_bucket >= ? AND views_delta IS NOT NULL
  `).get(post.id, new Date(Date.parse(now) - 3 * 3_600_000).toISOString()) as { delta: number };
  const schedule = nextCaptureAt({
    publishedAtMs: Date.parse(post.published_at ?? post.bound_at), nowMs: Date.parse(now), views: metrics.views,
    recentThreeHourDelta: recent.delta,
  });
  db.prepare("UPDATE posts SET tracking_state=?, next_capture_at=?, capture_failures=0, updated_at=? WHERE id=?")
    .run(schedule.state, schedule.nextCaptureAt, now, post.id);
  syncPostReadModel(db, post.id, now);
}

export function recordSnapshot(
  db: ContentLabDatabase,
  post: PostRow,
  metrics: PostMetrics,
  source: string,
  now = new Date().toISOString(),
): void {
  const bucket = hourBucket(now);
  const previousRow = db.prepare(`
    SELECT captured_at, views, likes, comments, shares, saves
    FROM metric_snapshots WHERE post_id=? AND ok=1 AND hour_bucket < ?
    ORDER BY hour_bucket DESC LIMIT 1
  `).get(post.id, bucket) as { captured_at: string; views: number; likes: number; comments: number; shares: number; saves: number | null } | undefined;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO metric_snapshots(id, post_id, captured_at, hour_bucket, views, likes, comments, shares, saves, source, ok, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(post_id, hour_bucket) DO UPDATE SET
      captured_at=excluded.captured_at, views=excluded.views, likes=excluded.likes,
      comments=excluded.comments, shares=excluded.shares, saves=excluded.saves,
      source=excluded.source, ok=1, error=NULL
  `).run(id, post.id, now, bucket, metrics.views, metrics.likes, metrics.comments, metrics.shares, metrics.saves, source, now);
  const snapshot = db.prepare("SELECT * FROM metric_snapshots WHERE post_id=? AND hour_bucket=?").get(post.id, bucket) as Record<string, unknown>;
  const externalPostId = post.site_post_id ?? post.id;
  putSyncEvent(db, "snapshot", `${externalPostId}:${bucket}`, {
    id: snapshot.id, postId: externalPostId, sitePostId: post.site_post_id, localPostId: post.id,
    capturedAt: snapshot.captured_at, hourBucket: snapshot.hour_bucket, views: snapshot.views,
    likes: snapshot.likes, comments: snapshot.comments, shares: snapshot.shares, saves: snapshot.saves,
    source: snapshot.source, ok: snapshot.ok, error: snapshot.error,
  }, now);

  const previous: MetricPoint | null = previousRow ? {
    capturedAt: previousRow.captured_at, views: previousRow.views, likes: previousRow.likes,
    comments: previousRow.comments, shares: previousRow.shares, saves: previousRow.saves,
  } : null;
  const rows = deriveHourlyRows(previous, { capturedAt: now, ...metrics });
  for (const row of rows) {
    db.prepare(`
      INSERT INTO post_hourly(post_id, hour_bucket, views_cum, views_delta, likes_delta, comments_delta, shares_delta, saves_delta, coverage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id, hour_bucket) DO UPDATE SET
        views_cum=excluded.views_cum, views_delta=excluded.views_delta, likes_delta=excluded.likes_delta,
        comments_delta=excluded.comments_delta, shares_delta=excluded.shares_delta,
        saves_delta=excluded.saves_delta, coverage=excluded.coverage
    `).run(post.id, row.hourBucket, row.viewsCum, row.viewsDelta, row.likesDelta, row.commentsDelta, row.sharesDelta, row.savesDelta, row.coverage);
  }

  if (previous) {
    const currentDelta = Math.max(0, metrics.views - previous.views);
    const prior = (db.prepare(`
      SELECT views_delta AS value FROM post_hourly
      WHERE post_id=? AND hour_bucket < ? AND views_delta IS NOT NULL
      ORDER BY hour_bucket DESC LIMIT 6
    `).all(post.id, bucket) as Array<{ value: number }>).map((row) => row.value);
    const offsetHours = MARKET_UTC_OFFSET_HOURS[post.market?.toUpperCase() ?? ""] ?? 0;
    const day = new Date(Date.parse(now) + offsetHours * 3_600_000).toISOString().slice(0, 10);
    for (const candidate of evaluateAlerts({ postId: post.id, previousViews: previous.views, currentViews: metrics.views, currentDelta, priorSixDeltas: prior, day })) {
      if (candidate.rule === "acceleration") {
        const cooldown = db.prepare("SELECT 1 FROM alerts WHERE post_id=? AND rule='acceleration' AND fired_at>? LIMIT 1")
          .get(post.id, new Date(Date.parse(now) - 6 * 3_600_000).toISOString());
        if (cooldown) continue;
      }
      insertAlert(db, {
        postId: post.id, rule: candidate.rule, dedupeKey: candidate.dedupeKey,
        payload: { postId: post.id, videoId: post.video_id, url: post.url, market: post.market, previousViews: previous.views, currentViews: metrics.views, delta: currentDelta, level: candidate.level },
      }, now);
    }
  }
  refreshCheckpoints(db, post.id, now);
  scheduleNextCapture(db, post, metrics, now);
}

function recordUnavailable(
  db: ContentLabDatabase,
  post: PostRow,
  source: string,
  error: string,
  options: { terminal?: boolean } = {},
  now = new Date().toISOString(),
): void {
  const bucket = hourBucket(now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO metric_snapshots(id, post_id, captured_at, hour_bucket, source, ok, error, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(post_id, hour_bucket) DO UPDATE SET
      captured_at=CASE WHEN metric_snapshots.ok=0 THEN excluded.captured_at ELSE metric_snapshots.captured_at END,
      source=CASE WHEN metric_snapshots.ok=0 THEN excluded.source ELSE metric_snapshots.source END,
      error=CASE WHEN metric_snapshots.ok=0 THEN excluded.error ELSE metric_snapshots.error END
  `).run(id, post.id, now, bucket, source, error.slice(0, 2_000), now);
  const snapshot = db.prepare("SELECT * FROM metric_snapshots WHERE post_id=? AND hour_bucket=?").get(post.id, bucket) as Record<string, unknown>;
  const externalPostId = post.site_post_id ?? post.id;
  putSyncEvent(db, "snapshot", `${externalPostId}:${bucket}`, {
    id: snapshot.id, postId: externalPostId, sitePostId: post.site_post_id, localPostId: post.id,
    capturedAt: snapshot.captured_at, hourBucket: snapshot.hour_bucket, views: snapshot.views,
    likes: snapshot.likes, comments: snapshot.comments, shares: snapshot.shares, saves: snapshot.saves,
    source: snapshot.source, ok: snapshot.ok, error: snapshot.error,
  }, now);
  db.prepare(`
    INSERT INTO post_hourly(post_id, hour_bucket, coverage) VALUES (?, ?, 'missing')
    ON CONFLICT(post_id, hour_bucket) DO NOTHING
  `).run(post.id, bucket);
  db.prepare(`
    UPDATE posts SET capture_failures=capture_failures+1,
      tracking_state=CASE WHEN ? THEN 'stopped' ELSE tracking_state END,
      stop_reason=CASE WHEN ? THEN ? ELSE stop_reason END,
      next_capture_at=CASE WHEN ? THEN NULL ELSE ? END, updated_at=? WHERE id=?
  `).run(options.terminal ? 1 : 0, options.terminal ? 1 : 0, error.slice(0, 500), options.terminal ? 1 : 0,
    new Date(Date.parse(now) + 15 * 60_000).toISOString(), now, post.id);
  const failures = (db.prepare("SELECT capture_failures FROM posts WHERE id=?").get(post.id) as { capture_failures: number }).capture_failures;
  if (failures >= 3) {
    insertAlert(db, {
      postId: post.id, rule: "ops_capture_failures", dedupeKey: `ops:capture:${post.id}:${bucket}`,
      payload: { postId: post.id, videoId: post.video_id, failures, error },
    }, now);
  }
  refreshCheckpoints(db, post.id, now);
  syncPostReadModel(db, post.id, now);
}

export async function ingestPost(
  db: ContentLabDatabase,
  provider: MetricsProvider,
  payload: { url: string; market?: string | null; projectTag?: string | null; boundBy?: string | null; sitePostId?: string | null },
  now = new Date().toISOString(),
): Promise<PostRow> {
  const result = await provider.fetchPost(payload.url);
  // A profile or other page can come back with the handle as its id; never store that as a post.
  if (!/^\d{8,}$/.test(result.metadata.videoId)) throw new Error(`Not a TikTok video or photo post: ${payload.url}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const post = upsertPost(db, result, { market: payload.market ?? null, projectTag: payload.projectTag ?? null, boundBy: payload.boundBy ?? null, sitePostId: payload.sitePostId ?? null }, now);
    if (result.metrics) recordSnapshot(db, post, result.metrics, result.source, now);
    else recordUnavailable(db, post, result.source, result.fallbackReason ?? "oEmbed returned metadata only", {}, now);
    enqueueJob(db, { kind: "analyze", payload: { postId: post.id, version: 1 }, idempotencyKey: `analyze:${post.id}:1` });
    if (!result.metrics) enqueueJob(db, { kind: "capture", payload: { postId: post.id }, runAt: new Date(Date.parse(now) + 60_000).toISOString(), idempotencyKey: `capture:${post.id}:${now}` });
    db.exec("COMMIT");
    return post;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function capturePost(
  db: ContentLabDatabase,
  provider: MetricsProvider,
  postId: string,
  now = new Date().toISOString(),
): Promise<void> {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(postId) as unknown as PostRow | undefined;
  if (!post) throw new Error(`Unknown post ${postId}`);
  if (post.tracking_state === "stopped") return;
  try {
    const result = await provider.fetchPost(post.url);
    db.exec("BEGIN IMMEDIATE");
    try {
      upsertPost(db, result, { market: post.market, projectTag: post.project_tag, boundBy: null, sitePostId: post.site_post_id }, now);
      if (result.metrics) recordSnapshot(db, post, result.metrics, result.source, now);
      else recordUnavailable(db, post, result.source, result.fallbackReason ?? "oEmbed returned metadata only", {}, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (!result.metrics) throw new ProviderError("Metrics unavailable; metadata was refreshed from oEmbed", { retryable: true, unavailableReason: "upstream" });
  } catch (error) {
    if (error instanceof ProviderError && error.message.startsWith("Metrics unavailable")) throw error;
    const terminal = error instanceof ProviderError && error.unavailableReason === "private_or_deleted";
    db.exec("BEGIN IMMEDIATE");
    try {
      recordUnavailable(db, post, "tikwm", error instanceof Error ? error.message : String(error), { terminal }, now);
      db.exec("COMMIT");
    } catch (dbError) {
      db.exec("ROLLBACK");
      throw dbError;
    }
    if (!terminal) throw error;
  }
}

/** Refresh post metadata (e.g. expiring carousel image URLs) without recording a metric snapshot. */
export async function refreshPostMetadata(db: ContentLabDatabase, provider: MetricsProvider, postId: string, now = new Date().toISOString()): Promise<void> {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(postId) as unknown as PostRow | undefined;
  if (!post) throw new Error(`Unknown post ${postId}`);
  const result = await provider.fetchPost(post.url);
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertPost(db, result, { market: post.market, projectTag: post.project_tag, boundBy: null, sitePostId: post.site_post_id }, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordCodexAuthAlert(db: ContentLabDatabase, error: string, action = "Run `codex login` on the Mac", now = new Date().toISOString()): void {
  const hour = hourBucket(now);
  insertAlert(db, { postId: null, rule: "ops_codex_auth", dedupeKey: `ops:codex-auth:${hour}`, payload: { error, action } }, now);
}

export function syntheticVideoId(url: string): string {
  return `url-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

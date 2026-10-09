import { z } from "zod";

import {
  asRecord,
  getD1,
  integer,
  jsonError,
  nullableInteger,
  nullableString,
  pick,
  requireWorker,
} from "@/lib/server/content-db";

const eventSchema = z.object({
  id: z.string().min(1).max(160),
  type: z.enum(["post", "snapshot", "features", "prediction", "job", "alert", "playbook", "post_deleted", "recreation"]),
  entityKey: z.string().min(1).max(160),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
}).strict();

const bodySchema = z.object({ workerId: z.string().min(1).max(120), events: z.array(eventSchema).min(1).max(50) }).strict();
type SyncEvent = z.infer<typeof eventSchema>;

export async function POST(request: Request) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  if (Number(request.headers.get("content-length") ?? 0) > 1_500_000) return jsonError("同步批次太大 · Sync batch too large", 413);
  let body: z.infer<typeof bodySchema>;
  try { body = bodySchema.parse(await request.json()); } catch (error) { return jsonError("同步数据格式不正确 · Invalid sync data", 400, error instanceof z.ZodError ? error.flatten() : undefined); }

  try {
    const db = getD1();
    const accepted: string[] = [];
    const ignored: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    // A post event establishes the local-id -> hosted-id alias used by the
    // remaining events in the same batch. Keep that relationship deterministic
    // even when SQLite rows share the same timestamp.
    const orderedEvents = [...body.events].sort((left, right) => eventPriority(left.type) - eventPriority(right.type));
    for (const event of orderedEvents) {
      try {
        const duplicate = await db.prepare("SELECT id FROM sync_events WHERE id = ? LIMIT 1").bind(event.id).first();
        if (duplicate) { ignored.push(event.id); continue; }
        await applyEvent(db, event);
        await db.prepare(`INSERT INTO sync_events (id, worker_id, event_type, entity_key, occurred_at, accepted_at)
          VALUES (?, ?, ?, ?, ?, ?)`).bind(event.id, body.workerId, event.type, event.entityKey, event.occurredAt, new Date().toISOString()).run();
        accepted.push(event.id);
      } catch (error) {
        console.error("sync event failed", { id: event.id, type: event.type, error });
        errors.push({ id: event.id, error: error instanceof Error ? error.message.slice(0, 300) : "sync failed" });
      }
    }

    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO workers (id, status, queue_depth, last_seen_at, details_json) VALUES (?, 'online', 0, ?, '{}')
      ON CONFLICT(id) DO UPDATE SET status = 'online', last_seen_at = excluded.last_seen_at`).bind(body.workerId, now).run();
    return Response.json({ accepted, ignored, errors, serverTime: now });
  } catch (error) {
    console.error("sync batch failed", error);
    return jsonError("同步服务暂时不可用 · Sync temporarily unavailable", 503);
  }
}

function eventPriority(type: SyncEvent["type"]): number {
  return type === "post" ? 0 : type === "job" ? 2 : type === "post_deleted" ? 3 : 1;
}

async function applyEvent(db: D1Database, event: SyncEvent) {
  switch (event.type) {
    case "post": return syncPost(db, event);
    case "snapshot": return syncSnapshot(db, event);
    case "features": return syncFeatures(db, event);
    case "prediction": return syncPrediction(db, event);
    case "job": return syncJob(db, event);
    case "alert": return syncAlert(db, event);
    case "playbook": return syncPlaybook(db, event);
    case "post_deleted": return syncPostDeleted(db, event);
    case "recreation": return syncRecreation(db, event);
  }
}

/** Status, notes and file paths of an Agent recreation, as the worker progresses. */
async function syncRecreation(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const id = nullableString(pick(payload, "id")) ?? event.entityKey;
  const postId = nullableString(pick(payload, "postId"));
  if (!postId) throw new Error("recreation.postId is required");
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO recreations (id, post_id, status, notes_json, video_url, cover_url, error, counts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, notes_json = COALESCE(excluded.notes_json, recreations.notes_json),
      video_url = COALESCE(excluded.video_url, recreations.video_url), cover_url = COALESCE(excluded.cover_url, recreations.cover_url),
      error = excluded.error, counts = excluded.counts, updated_at = excluded.updated_at`)
    .bind(id, postId, String(pick(payload, "status") ?? "queued"), nullableString(pick(payload, "notesJson")), nullableString(pick(payload, "videoUrl")),
      nullableString(pick(payload, "coverUrl")), nullableString(pick(payload, "error")), Number(pick(payload, "counts") ?? 1), now, now).run();
}

/** The owner removed a post locally: drop the hosted copy and everything attached to it. */
async function syncPostDeleted(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const localPostId = nullableString(pick(payload, "localPostId", "local_post_id"));
  const sitePostId = nullableString(pick(payload, "sitePostId", "site_post_id"));
  const url = nullableString(pick(payload, "url"));
  const ids = new Set<string>();
  if (sitePostId) ids.add(sitePostId);
  if (localPostId) {
    const alias = await db.prepare("SELECT post_id FROM post_aliases WHERE source_key = ? LIMIT 1").bind(localPostId).first<Record<string, unknown>>();
    if (alias?.post_id) ids.add(String(alias.post_id));
    const own = await db.prepare("SELECT id FROM posts WHERE id = ? LIMIT 1").bind(localPostId).first<Record<string, unknown>>();
    if (own?.id) ids.add(String(own.id));
  }
  if (url) {
    const byUrl = await db.prepare("SELECT id FROM posts WHERE url = ? LIMIT 1").bind(url).first<Record<string, unknown>>();
    if (byUrl?.id) ids.add(String(byUrl.id));
  }
  const statements = [...ids].flatMap((id) => [
    db.prepare("DELETE FROM metric_snapshots WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM post_features WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM predictions WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM alerts WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM post_aliases WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM recreations WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.sitePostId') = ? OR json_extract(payload_json, '$.postId') = ?").bind(id, id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
  if (statements.length > 0) await db.batch(statements);
}

async function syncPost(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const localPostId = nullableString(pick(payload, "localPostId", "local_post_id")) ?? event.entityKey;
  const suppliedSitePostId = nullableString(pick(payload, "sitePostId", "site_post_id"));
  const incomingUrl = nullableString(pick(payload, "url"));
  const incomingVideoId = nullableString(pick(payload, "videoId", "video_id"));
  const alias = await db.prepare("SELECT post_id FROM post_aliases WHERE source_key = ? LIMIT 1")
    .bind(localPostId).first<Record<string, unknown>>();
  let existing: Record<string, unknown> | null = null;
  if (suppliedSitePostId) {
    existing = await db.prepare("SELECT * FROM posts WHERE id = ? LIMIT 1").bind(suppliedSitePostId).first<Record<string, unknown>>();
  }
  if (!existing && alias?.post_id) {
    existing = await db.prepare("SELECT * FROM posts WHERE id = ? LIMIT 1").bind(alias.post_id).first<Record<string, unknown>>();
  }
  if (!existing && incomingUrl) {
    existing = await db.prepare("SELECT * FROM posts WHERE url = ? LIMIT 1").bind(incomingUrl).first<Record<string, unknown>>();
  }
  if (!existing && incomingVideoId) {
    existing = await db.prepare("SELECT * FROM posts WHERE video_id = ? LIMIT 1").bind(incomingVideoId).first<Record<string, unknown>>();
  }
  const hostedPostId = suppliedSitePostId ?? nullableString(alias?.post_id) ?? nullableString(existing?.id) ?? localPostId;
  const url = incomingUrl ?? nullableString(existing?.url);
  if (!url) throw new Error("post.url is required");
  const value = (keys: string[], current: unknown = null) => pick(payload, ...keys) ?? current;
  const featuresState = nullableString(pick(payload, "featuresState", "features_state"));
  const incomingAnalysisState = nullableString(pick(payload, "analysisState", "analysis_state"));
  const analysisState = incomingAnalysisState
    ?? (featuresState === "ready" ? "complete" : featuresState === "features_failed" || featuresState === "failed" ? "failed" : null)
    ?? nullableString(existing?.analysis_state)
    ?? "queued";
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO posts (
      id, video_id, url, creator_handle, market, project_tag, post_type, caption, music_title, thumbnail_url,
      published_at, bound_at, tracking_state, analysis_state, next_capture_at, views, likes, comments, shares, saves,
      delta_24h, source, last_captured_at, updated_at, media_url, checkpoints_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      video_id = excluded.video_id, url = excluded.url, creator_handle = excluded.creator_handle,
      market = excluded.market, project_tag = excluded.project_tag, post_type = excluded.post_type,
      caption = excluded.caption, music_title = excluded.music_title, thumbnail_url = excluded.thumbnail_url,
      published_at = excluded.published_at, tracking_state = excluded.tracking_state,
      analysis_state = excluded.analysis_state, next_capture_at = excluded.next_capture_at,
      views = excluded.views, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
      saves = excluded.saves, delta_24h = excluded.delta_24h, source = excluded.source,
      last_captured_at = excluded.last_captured_at, updated_at = excluded.updated_at, media_url = excluded.media_url,
      checkpoints_json = excluded.checkpoints_json`).bind(
      hostedPostId,
      nullableString(value(["videoId", "video_id"], existing?.video_id)),
      url,
      nullableString(value(["creatorHandle", "creator_handle", "creator"], existing?.creator_handle)),
      nullableString(value(["market"], existing?.market)) ?? "VN",
      nullableString(value(["projectTag", "project_tag"], existing?.project_tag)),
      nullableString(value(["postType", "post_type", "type"], existing?.post_type)) ?? "video",
      nullableString(value(["caption"], existing?.caption)),
      nullableString(value(["musicTitle", "music_title"], existing?.music_title)),
      nullableString(value(["thumbnailUrl", "thumbnail_url", "coverUrl", "cover_url"], existing?.thumbnail_url)),
      nullableString(value(["publishedAt", "published_at"], existing?.published_at)),
      nullableString(value(["boundAt", "bound_at"], existing?.bound_at)) ?? event.occurredAt,
      nullableString(value(["trackingState", "tracking_state"], existing?.tracking_state)) ?? "active",
      analysisState,
      nullableString(value(["nextCaptureAt", "next_capture_at"], existing?.next_capture_at)),
      integer(value(["views"], existing?.views)),
      integer(value(["likes"], existing?.likes)),
      integer(value(["comments"], existing?.comments)),
      integer(value(["shares"], existing?.shares)),
      integer(value(["saves"], existing?.saves)),
      integer(value(["delta24h", "delta_24h"], existing?.delta_24h)),
      nullableString(value(["source"], existing?.source)),
      nullableString(value(["lastCapturedAt", "last_captured_at"], existing?.last_captured_at)),
      now,
      nullableString(value(["mediaUrl", "media_url"], existing?.media_url)),
      Array.isArray(pick(payload, "checkpoints")) ? JSON.stringify(pick(payload, "checkpoints")) : nullableString(existing?.checkpoints_json) ?? "[]",
    ).run();
  await db.prepare(`INSERT INTO post_aliases (source_key, post_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET post_id = excluded.post_id`)
    .bind(localPostId, hostedPostId, now).run();
}

async function resolvePostId(db: D1Database, localPostId: string): Promise<string> {
  const alias = await db.prepare("SELECT post_id FROM post_aliases WHERE source_key = ? LIMIT 1")
    .bind(localPostId).first<Record<string, unknown>>();
  return nullableString(alias?.post_id) ?? localPostId;
}

async function syncSnapshot(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const localPostId = nullableString(pick(payload, "postId", "post_id")) ?? event.entityKey.split(":")[0];
  const postId = await resolvePostId(db, localPostId);
  const capturedAt = nullableString(pick(payload, "capturedAt", "captured_at")) ?? event.occurredAt;
  const views = nullableInteger(pick(payload, "views"));
  const likes = nullableInteger(pick(payload, "likes"));
  const comments = nullableInteger(pick(payload, "comments"));
  const shares = nullableInteger(pick(payload, "shares"));
  const saves = nullableInteger(pick(payload, "saves"));
  const rawOk = pick(payload, "ok");
  const ok = rawOk === false || rawOk === 0 ? 0 : 1;
  const previous = ok && views != null
    ? await db.prepare(`SELECT views FROM metric_snapshots WHERE post_id = ? AND ok = 1 AND datetime(captured_at) < datetime(?)
        ORDER BY datetime(captured_at) DESC LIMIT 1`).bind(postId, capturedAt).first<Record<string, unknown>>()
    : null;
  const viewsDelta = nullableInteger(pick(payload, "viewsDelta", "views_delta"))
    ?? (previous && views != null ? Math.max(0, views - integer(previous.views)) : null);
  await db.prepare(`INSERT OR IGNORE INTO metric_snapshots (
      id, post_id, captured_at, views, likes, comments, shares, saves, views_delta, coverage, source, ok, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      event.id, postId, capturedAt, views, likes, comments, shares, saves,
      viewsDelta,
      nullableString(pick(payload, "coverage")) ?? (ok ? "observed" : "missing"),
      nullableString(pick(payload, "source")), ok,
      nullableString(pick(payload, "error")),
    ).run();
  if (ok && views != null) {
    await db.prepare(`UPDATE posts SET views = ?, likes = COALESCE(?, likes), comments = COALESCE(?, comments),
      shares = COALESCE(?, shares), saves = COALESCE(?, saves), source = ?, last_captured_at = ?,
      delta_24h = (SELECT COALESCE(SUM(MAX(views_delta, 0)), 0) FROM metric_snapshots WHERE post_id = ? AND datetime(captured_at) >= datetime('now', '-1 day')),
      updated_at = ? WHERE id = ?`).bind(
      views, likes, comments, shares, saves, nullableString(pick(payload, "source")), capturedAt, postId, new Date().toISOString(), postId,
    ).run();
  }
}

async function syncFeatures(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const localPostId = nullableString(pick(payload, "postId", "post_id")) ?? event.entityKey.split(":")[0];
  const postId = await resolvePostId(db, localPostId);
  const tags = asRecord(pick(payload, "tags"));
  const analysis = asRecord(pick(payload, "analysis"));
  const keyframes = Array.isArray(pick(payload, "keyframes")) ? pick(payload, "keyframes") : [];
  await db.prepare(`INSERT INTO post_features (
      post_id, version, model, taxonomy_version, tags_json, hook_text, hook_translation_zh, transcript, summary_zh, formula_zh, keyframes_json,
      script_json, computed_json, frames_json, texts_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET version = excluded.version, model = excluded.model, taxonomy_version = excluded.taxonomy_version,
      tags_json = excluded.tags_json, hook_text = excluded.hook_text, hook_translation_zh = excluded.hook_translation_zh,
      transcript = excluded.transcript, summary_zh = excluded.summary_zh, formula_zh = excluded.formula_zh,
      keyframes_json = excluded.keyframes_json, script_json = excluded.script_json, computed_json = excluded.computed_json,
      frames_json = excluded.frames_json, texts_json = excluded.texts_json, created_at = excluded.created_at`).bind(
      postId, nullableString(pick(payload, "version")) ?? event.id, nullableString(pick(payload, "model")),
      nullableString(pick(payload, "taxonomyVersion", "taxonomy_version")) ?? "v3", JSON.stringify(tags),
      nullableString(pick(payload, "hookText", "hook_text")), nullableString(pick(payload, "hookTranslationZh", "hook_translation_zh")) ?? nullableString(pick(analysis, "hook_translation_zh")),
      nullableString(pick(payload, "transcript")), nullableString(pick(payload, "summaryZh", "summary_zh")),
      nullableString(pick(payload, "formulaZh", "formula_zh")) ?? nullableString(pick(analysis, "formula_zh")), JSON.stringify(keyframes),
      JSON.stringify(Array.isArray(pick(payload, "script")) ? pick(payload, "script") : []),
      JSON.stringify(asRecord(pick(payload, "computed"))),
      JSON.stringify(Array.isArray(pick(payload, "frames")) ? pick(payload, "frames") : []),
      JSON.stringify(Object.fromEntries(["hook_translation_zh", "hook_translation_en", "summary_zh", "summary_en", "formula_zh", "formula_en"]
        .map((key) => [key, nullableString(pick(analysis, key))]).filter(([, value]) => value))),
      event.occurredAt,
    ).run();
  await db.prepare("UPDATE posts SET analysis_state = 'complete', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), postId).run();
}

async function syncPrediction(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const localPostId = nullableString(pick(payload, "postId", "post_id")) ?? event.entityKey;
  const postId = await resolvePostId(db, localPostId);
  await db.prepare(`INSERT OR REPLACE INTO predictions (id, post_id, stage, made_at, rank_position, rank_total, band, rationale, inputs_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      event.id, postId, nullableString(pick(payload, "stage")) ?? "bind", event.occurredAt,
      nullableInteger(pick(payload, "rankPosition", "rank_position", "rank")), nullableInteger(pick(payload, "rankTotal", "rank_total", "cohortSize", "cohort_size")),
      nullableString(pick(payload, "band")), nullableString(pick(payload, "rationale")), JSON.stringify(asRecord(pick(payload, "inputs"))),
    ).run();
}

async function syncJob(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const status = nullableString(pick(payload, "status")) ?? "complete";
  await db.prepare("UPDATE jobs SET status = ?, last_error = ?, lease_owner = NULL, locked_until = NULL, updated_at = ? WHERE id = ?")
    .bind(status, nullableString(pick(payload, "lastError", "last_error")), new Date().toISOString(), event.entityKey).run();
}

async function syncPlaybook(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const market = nullableString(pick(payload, "market"));
  const version = nullableInteger(pick(payload, "version"));
  const markdown = nullableString(pick(payload, "markdown"));
  if (!market || version === null || !markdown) throw new Error("playbook needs market, version and markdown");
  await db.prepare(`INSERT INTO playbooks (id, market, version, week_start, created_at, model, document_json, evidence_json, markdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json, evidence_json = excluded.evidence_json, markdown = excluded.markdown`).bind(
      nullableString(pick(payload, "id")) ?? event.entityKey, market.toUpperCase(), version,
      nullableString(pick(payload, "weekStart", "week_start")) ?? event.occurredAt, nullableString(pick(payload, "createdAt", "created_at")) ?? event.occurredAt,
      nullableString(pick(payload, "model")), JSON.stringify(asRecord(pick(payload, "document"))), JSON.stringify(asRecord(pick(payload, "evidence"))), markdown,
    ).run();
}

async function syncAlert(db: D1Database, event: SyncEvent) {
  const payload = event.payload;
  const dedupeKey = nullableString(pick(payload, "dedupeKey", "dedupe_key")) ?? event.id;
  const localPostId = nullableString(pick(payload, "postId", "post_id")) ?? event.entityKey;
  const postId = localPostId ? await resolvePostId(db, localPostId) : null;
  await db.prepare(`INSERT OR IGNORE INTO alerts (id, post_id, rule, dedupe_key, fired_at, payload_json, delivered_at, delivery_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      event.id, postId,
      nullableString(pick(payload, "rule")) ?? "signal", dedupeKey, event.occurredAt, JSON.stringify(asRecord(pick(payload, "payload"))),
      nullableString(pick(payload, "deliveredAt", "delivered_at")), nullableString(pick(payload, "deliveryError", "delivery_error")),
    ).run();
}

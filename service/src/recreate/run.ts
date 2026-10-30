import type { ServiceConfig } from "../config.js";
import type { ContentLabDatabase } from "../db/database.js";
import { AnalyzerQuotaError } from "../analyzer/claude.js";
import { putSyncEvent } from "../sync/outbox.js";
import type { ImageCopyNotes } from "../copy/run.js";
import { runRecreateAgent, type RecreateNotes } from "./agent.js";
import { renderRecreation, type Rendition } from "./render.js";
import { prepareRecreateWorkspace, SourceUnavailableError, type RecreateWorkspace } from "./workspace.js";

export interface RecreateDeps {
  refresh: (postId: string) => Promise<void>;
  upload: (recreationId: string, filename: "video.mp4" | "cover.jpg", path: string, contentType: string) => Promise<string>;
  notify?: (text: string) => Promise<void>;
  workspace?: (db: ContentLabDatabase, config: ServiceConfig, input: { recreationId: string; postId: string }) => Promise<RecreateWorkspace>;
  agent?: (dir: string, model: string) => Promise<{ notes: RecreateNotes; turns: number }>;
  render?: (dir: string, sourceDurationS: number) => Promise<Rendition>;
}

export type Status = "queued" | "preparing" | "designing" | "rendering" | "complete" | "failed";
export type SaveFields = { notes?: RecreateNotes | ImageCopyNotes; videoUrl?: string; coverUrl?: string; error?: string; counts?: number };

/** Persist a recreation's status and queue the matching Site event. */
export function saveRecreation(db: ContentLabDatabase, ids: { id: string; postId: string; sitePostId: string }, status: Status, fields: SaveFields = {}): void {
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO recreations(id, post_id, site_post_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`).run(ids.id, ids.postId, ids.sitePostId, status, at, at);
  db.prepare(`UPDATE recreations SET notes_json=COALESCE(?, notes_json), video_url=COALESCE(?, video_url), cover_url=COALESCE(?, cover_url), error=?, counts=COALESCE(?, counts),
    finished_at=CASE WHEN ? IN ('complete','failed') THEN ? ELSE NULL END WHERE id=?`)
    .run(fields.notes ? JSON.stringify(fields.notes) : null, fields.videoUrl ?? null, fields.coverUrl ?? null, fields.error ?? null, fields.counts ?? null, status, at, ids.id);
  const row = db.prepare("SELECT * FROM recreations WHERE id=?").get(ids.id) as Record<string, unknown>;
  putSyncEvent(db, "recreation", ids.id, { id: ids.id, postId: ids.sitePostId, status, notesJson: row.notes_json, videoUrl: row.video_url, coverUrl: row.cover_url, error: row.error, counts: row.counts, updatedAt: at }, at);
}

/**
 * A recreate job whose last attempt was still running when the worker stopped is never leased again.
 * Once its lease has expired, mark the job dead and the recreation failed so the post page stops waiting.
 */
export function failStaleRecreations(db: ContentLabDatabase, now = new Date()): number {
  const stale = db.prepare(`SELECT id, payload_json FROM jobs WHERE kind='recreate' AND status='running' AND attempts >= max_attempts AND locked_until IS NOT NULL AND locked_until <= ?`)
    .all(now.toISOString()) as Array<{ id: string; payload_json: string }>;
  for (const job of stale) {
    const payload = JSON.parse(job.payload_json) as { recreationId: string; sitePostId: string };
    db.prepare("UPDATE jobs SET status='dead', last_error='worker stopped during the final attempt', locked_until=NULL, lease_owner=NULL, updated_at=? WHERE id=?").run(now.toISOString(), job.id);
    const existing = db.prepare("SELECT post_id FROM recreations WHERE id=?").get(payload.recreationId) as { post_id: string } | undefined;
    saveRecreation(db, { id: payload.recreationId, postId: existing?.post_id ?? payload.sitePostId, sitePostId: payload.sitePostId }, "failed", { error: "worker_stopped" });
  }
  return stale.length;
}

/** Error categories shown on the public page; full messages stay local and go to the owner on Feishu. */
type ErrorCategory = "source_unavailable" | "prepare_failed" | "agent_failed" | "render_failed" | "verify_failed" | "upload_failed" | "paused_for_quota" | "post_not_tracked" | "worker_stopped";

export async function runRecreation(db: ContentLabDatabase, config: ServiceConfig, input: { recreationId: string; sitePostId: string; finalAttempt?: boolean }, deps: RecreateDeps): Promise<void> {
  const post = db.prepare("SELECT id FROM posts WHERE site_post_id=? OR id=? LIMIT 1").get(input.sitePostId, input.sitePostId) as { id: string } | undefined;
  const save = (status: Status, fields: SaveFields = {}) => saveRecreation(db, { id: input.recreationId, postId: post?.id ?? input.sitePostId, sitePostId: input.sitePostId }, status, fields);
  if (!post) { save("failed", { error: "post_not_tracked", counts: 0 }); return; }
  let stage: Status = "preparing";
  let category: ErrorCategory = "prepare_failed";
  try {
    save("preparing");
    const workspace = await (deps.workspace ?? ((d, c, i) => prepareRecreateWorkspace(d, c, i, { refresh: deps.refresh })))(db, config, { recreationId: input.recreationId, postId: post.id });
    stage = "designing"; category = "agent_failed"; save(stage);
    const { notes } = await (deps.agent ?? runRecreateAgent)(workspace.dir, config.claudeModel);
    stage = "rendering"; category = "render_failed"; save(stage, { notes });
    const rendition = await (deps.render ?? renderRecreation)(workspace.dir, workspace.sourceDurationS);
    category = "upload_failed";
    const videoUrl = await deps.upload(input.recreationId, "video.mp4", rendition.videoPath, "video/mp4");
    const coverUrl = await deps.upload(input.recreationId, "cover.jpg", rendition.coverPath, "image/jpeg");
    save("complete", { videoUrl, coverUrl });
    await deps.notify?.(`重制完成 · post ${input.sitePostId}：${notes.summary_zh}`).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SourceUnavailableError) {
      save("failed", { error: "source_unavailable", counts: 0 });
      await deps.notify?.(`重制失败（原片不可用，不计次数）· post ${input.sitePostId}：${message.slice(0, 300)}`).catch(() => undefined);
      return;
    }
    if (error instanceof AnalyzerQuotaError) {
      // The worker defers quota pauses without spending an attempt, so the recreation is still pending.
      save("queued", { error: "paused_for_quota" });
      throw error;
    }
    if (category === "render_failed" && /^Rendition /.test(message)) category = "verify_failed";
    if (input.finalAttempt) {
      save("failed", { error: category });
      await deps.notify?.(`重制失败 · post ${input.sitePostId}（${category}）：${message.slice(0, 500)}`).catch(() => undefined);
    } else {
      save(stage, { error: category });
    }
    throw error;
  }
}

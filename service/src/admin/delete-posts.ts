import { rmSync } from "node:fs";
import { join } from "node:path";

import type { ContentLabDatabase } from "../db/database.js";
import { putSyncEvent } from "../sync/outbox.js";

export interface DeletedPost { localPostId: string | null; sitePostId: string | null; url: string }

/**
 * Remove posts and everything derived from them, plus ingest jobs for the same links that never became posts.
 * Each removal queues a `post_deleted` event so the Site drops its copy too.
 */
export function deletePosts(db: ContentLabDatabase, refs: { postIds: string[]; urls: string[] }, mediaDir: string | null, now = new Date().toISOString()): DeletedPost[] {
  const deleted: DeletedPost[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const postId of refs.postIds) {
      const post = db.prepare("SELECT id, url, site_post_id FROM posts WHERE id=?").get(postId) as { id: string; url: string; site_post_id: string | null } | undefined;
      if (!post) continue;
      for (const table of ["metric_snapshots", "post_hourly", "post_features", "predictions", "alerts"]) db.prepare(`DELETE FROM ${table} WHERE post_id=?`).run(post.id);
      db.prepare("DELETE FROM jobs WHERE json_extract(payload_json,'$.postId')=? OR (kind='ingest' AND json_extract(payload_json,'$.url')=?)").run(post.id, post.url);
      db.prepare("DELETE FROM sync_outbox WHERE entity_key=? OR json_extract(payload_json,'$.postId')=? OR json_extract(payload_json,'$.localPostId')=?").run(post.id, post.id, post.id);
      db.prepare("DELETE FROM posts WHERE id=?").run(post.id);
      deleted.push({ localPostId: post.id, sitePostId: post.site_post_id, url: post.url });
    }
    for (const url of refs.urls) {
      const jobs = db.prepare("SELECT id, payload_json FROM jobs WHERE kind='ingest' AND json_extract(payload_json,'$.url')=?").all(url) as Array<{ id: string; payload_json: string }>;
      for (const job of jobs) {
        const sitePostId = (JSON.parse(job.payload_json) as { sitePostId?: string | null }).sitePostId ?? null;
        db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
        if (!deleted.some((item) => item.url === url)) deleted.push({ localPostId: null, sitePostId, url });
      }
    }
    for (const item of deleted) putSyncEvent(db, "post_deleted", item.localPostId ?? item.sitePostId ?? item.url, { ...item, deletedAt: now }, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (mediaDir) for (const item of deleted) if (item.localPostId) rmSync(join(mediaDir, item.localPostId), { recursive: true, force: true });
  return deleted;
}

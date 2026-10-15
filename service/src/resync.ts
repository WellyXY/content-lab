import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { syncEvaluation } from "./analyzer/evaluate.js";
import { latestPlaybook, syncPlaybook } from "./analyzer/playbook.js";
import { syncPostReadModel } from "./collector.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { uploadKeyframes } from "./sync/media.js";
import { putSyncEvent } from "./sync/outbox.js";

/**
 * Re-queue every post's read model, latest analysis and latest assessment, plus
 * each market's latest playbook, for the next worker sync. Use it after a Site
 * release starts storing fields that earlier syncs sent but it ignored.
 */
const config = loadConfig();
if (!config.siteSyncUrl || !config.siteSyncToken) throw new Error("resync needs SITE_SYNC_URL and SITE_SYNC_TOKEN");
const db = openDatabase(config.dbPath);
try {
  const posts = db.prepare("SELECT id, site_post_id FROM posts").all() as Array<{ id: string; site_post_id: string | null }>;
  let features = 0;
  let predictions = 0;
  for (const post of posts) {
    const external = post.site_post_id ?? post.id;
    syncPostReadModel(db, post.id);
    const row = db.prepare("SELECT * FROM post_features WHERE post_id=? ORDER BY version DESC LIMIT 1").get(post.id) as Record<string, unknown> | undefined;
    if (row) {
      const analysis = JSON.parse(String(row.analysis_json)) as Record<string, unknown>;
      const manifest = join(config.mediaDir, post.id, "frames-v2.json");
      const frames = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { frames: Array<{ file: string }> }).frames : [];
      const keyframes = frames.length ? await uploadKeyframes(config, external, frames.map((frame) => join(config.mediaDir, post.id, frame.file))) : JSON.parse(String(row.keyframes_json)) as string[];
      putSyncEvent(db, "features", `${external}:${String(row.version)}`, {
        postId: external, sitePostId: post.site_post_id, localPostId: post.id, version: row.version, model: row.model, taxonomyVersion: row.taxonomy_version,
        tags: JSON.parse(String(row.tags_json)), hookText: row.hook_text, transcript: row.transcript, summaryZh: row.summary_zh, keyframes,
        frames: analysis.frames ?? [], script: analysis.script_segments ?? [], computed: analysis.computed ?? {}, analysis, createdAt: row.created_at,
      });
      features += 1;
    }
    const prediction = db.prepare("SELECT * FROM predictions WHERE post_id=? AND id NOT LIKE 'eval-%' ORDER BY made_at DESC LIMIT 1").get(post.id) as Record<string, unknown> | undefined;
    if (prediction) {
      putSyncEvent(db, "prediction", String(prediction.id), {
        id: prediction.id, postId: external, sitePostId: post.site_post_id, localPostId: post.id, stage: prediction.stage, madeAt: prediction.made_at,
        rank: prediction.rank_value, cohortSize: prediction.cohort_size, band: prediction.band, modelVersion: prediction.model_version,
        rationale: prediction.rationale, inputs: JSON.parse(String(prediction.inputs_json)),
      });
      predictions += 1;
    }
    const evaluation = config.siteEvalSync ? db.prepare("SELECT id FROM predictions WHERE post_id=? AND id LIKE 'eval-%' ORDER BY made_at DESC LIMIT 1").get(post.id) as { id: string } | undefined : undefined;
    if (evaluation) { syncEvaluation(db, evaluation.id); predictions += 1; }
  }
  let playbooks = 0;
  if (config.sitePlaybookSync) {
    for (const { market } of db.prepare("SELECT DISTINCT market FROM playbooks").all() as Array<{ market: string }>) {
      const playbook = latestPlaybook(db, market);
      if (playbook) { syncPlaybook(db, playbook); playbooks += 1; }
    }
  }
  console.log(JSON.stringify({ posts: posts.length, features, predictions, playbooks, note: config.sitePlaybookSync ? "queued for the next worker sync" : "playbooks skipped: set SITE_PLAYBOOK_SYNC=1 after the Site release" }));
} finally {
  db.close();
}

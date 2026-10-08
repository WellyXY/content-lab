import { loadTaxonomy } from "./analyzer/schema.js";
import { recordSnapshot, upsertPost } from "./collector.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import type { ProviderResult } from "./providers/metrics.js";
import { putSyncEvent } from "./sync/outbox.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const taxonomy = loadTaxonomy(config.taxonomyPath);
const now = Date.now();
const samples = [
  { id: "7900000000000000001", handle: "synthetic_linh", market: "VN", project: "synthetic", views: 1_240_000, delta: 18_400, caption: "POV: the message you waited all night for" },
  { id: "7900000000000000002", handle: "synthetic_eda", market: "TR", project: "synthetic", views: 486_000, delta: 31_200, caption: "Three signs your crush is waiting for you" },
  { id: "7900000000000000003", handle: "synthetic_minh", market: "VN", project: "synthetic", views: 92_000, delta: 4_900, caption: "My friend said dating apps never work" },
] as const;

for (const [index, sample] of samples.entries()) {
  const firstAt = new Date(now - 2 * 3_600_000 - index * 60_000).toISOString();
  const secondAt = new Date(now - 3_600_000 - index * 60_000).toISOString();
  const result: ProviderResult = {
    source: "tikwm",
    metadata: {
      videoId: sample.id, url: `https://www.tiktok.com/@${sample.handle}/video/${sample.id}`,
      authorId: `synthetic-user-${index + 1}`, authorHandle: sample.handle, caption: sample.caption,
      type: "video", durationS: 12 + index * 5, musicTitle: index === 1 ? "Original sound" : "Synthetic pop track",
      coverUrl: null, mediaUrl: null, publishedAt: new Date(now - (index + 1) * 86_400_000).toISOString(),
    },
    metrics: null,
  };
  const post = upsertPost(db, result, { market: sample.market, projectTag: sample.project, boundBy: "synthetic-seed" }, firstAt);
  recordSnapshot(db, post, { views: sample.views - sample.delta, likes: Math.round(sample.views * 0.07), comments: Math.round(sample.views * 0.004), shares: Math.round(sample.views * 0.01), saves: Math.round(sample.views * 0.006) }, "synthetic", firstAt);
  recordSnapshot(db, post, { views: sample.views, likes: Math.round(sample.views * 0.071), comments: Math.round(sample.views * 0.0042), shares: Math.round(sample.views * 0.0105), saves: Math.round(sample.views * 0.0064) }, "synthetic", secondAt);
  const tags = Object.fromEntries(Object.entries(taxonomy.dimensions).map(([name, dimension]) => {
    const first = Object.keys(dimension.values)[0] ?? "none";
    return [name, { value: dimension.multi ? [first] : first, confidence: "medium", evidence: [] }];
  }));
  const analysis = { tags, frame_texts: [], hook_text: sample.caption, hook_translation_zh: "合成資料鉤子", transcript: "", summary_zh: "這是一筆只供本機 UI 與流程驗證的合成內容。", script_segments: [], formula_zh: "痛點開場 → 情境共鳴", taxonomy_gaps: [] };
  db.prepare(`
    INSERT INTO post_features(post_id, version, model, taxonomy_version, tags_json, hook_text, transcript, summary_zh, keyframes_json, analysis_json, created_at)
    VALUES (?, 1, 'synthetic', ?, ?, ?, '', ?, '[]', ?, ?)
    ON CONFLICT(post_id, version) DO UPDATE SET tags_json=excluded.tags_json, analysis_json=excluded.analysis_json, created_at=excluded.created_at
  `).run(post.id, taxonomy.version, JSON.stringify(tags), sample.caption, analysis.summary_zh, JSON.stringify(analysis), secondAt);
  db.prepare("UPDATE posts SET features_state='ready', next_capture_at=NULL WHERE id=?").run(post.id);
  putSyncEvent(db, "features", `${post.id}:1`, { postId: post.id, version: 1, model: "synthetic", taxonomyVersion: taxonomy.version, tags, summaryZh: analysis.summary_zh, analysis, createdAt: secondAt }, secondAt);
  const predictionId = `synthetic-prediction-${sample.id}`;
  db.prepare(`
    INSERT OR REPLACE INTO predictions(id, post_id, stage, made_at, rank_value, cohort_size, band, model_version, rationale, inputs_json)
    VALUES (?, ?, 'bind', ?, ?, 3, 'experimental_relative_rank', 'synthetic', ?, ?)
  `).run(predictionId, post.id, secondAt, index + 1, `合成相對排名 ${index + 1}/3，僅供介面驗證。`, JSON.stringify({ experimental: true, synthetic: true }));
  putSyncEvent(db, "prediction", predictionId, { id: predictionId, postId: post.id, stage: "bind", madeAt: secondAt, rank: index + 1, cohortSize: 3, band: "experimental_relative_rank", modelVersion: "synthetic", rationale: `合成相對排名 ${index + 1}/3，僅供介面驗證。`, inputs: { experimental: true, synthetic: true } }, secondAt);
}

const first = db.prepare("SELECT id FROM posts WHERE video_id=?").get(samples[0].id) as { id: string };
const alertId = "synthetic-alert-mover";
const firedAt = new Date(now - 30 * 60_000).toISOString();
db.prepare(`
  INSERT OR REPLACE INTO alerts(id, post_id, rule, dedupe_key, fired_at, payload_json, delivered_at, delivery_attempts)
  VALUES (?, ?, 'acceleration', 'synthetic:acceleration', ?, ?, ?, 1)
`).run(alertId, first.id, firedAt, JSON.stringify({ postId: first.id, market: "VN", currentViews: 1_240_000, previousViews: 1_221_600, delta: 18_400, synthetic: true }), firedAt);
putSyncEvent(db, "alert", alertId, { id: alertId, postId: first.id, rule: "acceleration", firedAt, payload: { synthetic: true }, deliveredAt: firedAt }, firedAt);

console.log(JSON.stringify({ ok: true, seededPosts: samples.length, database: config.dbPath }, null, 2));
db.close();

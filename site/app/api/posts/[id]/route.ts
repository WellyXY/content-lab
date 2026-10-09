import { type PostDetailData } from "@/lib/content-lab";
import { getD1, jsonError, rowToAlert, rowToFeature, rowToPost, rowToPrediction, rowToSnapshot } from "@/lib/server/content-db";
import { postKeyframes } from "@/lib/server/media-storage";
import { rowToRecreation } from "@/lib/server/recreations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  if (id.startsWith("demo-")) return jsonError("示范数据已移除，请返回真实帖子列表 · Demo data was removed; go back to the post list", 404);
  if (!id || id.length > 100) return jsonError("帖子 ID 不正确 · Invalid post ID", 400);

  try {
    const db = getD1();
    const [postResult, snapshotsResult, featureResult, predictionsResult, alertsResult, recreationsResult] = await db.batch([
      db.prepare(`SELECT p.*,
        pred.rank_position, pred.rank_total,
        json_extract(f.tags_json, '$.hook_type.value') AS hook_type,
        json_extract(f.tags_json, '$.topic.value') AS topic
        FROM posts p
        LEFT JOIN post_features f ON f.post_id = p.id
        LEFT JOIN predictions pred ON pred.id = (SELECT id FROM predictions WHERE post_id = p.id ORDER BY made_at DESC LIMIT 1)
        WHERE p.id = ? LIMIT 1`).bind(id),
      db.prepare("SELECT * FROM metric_snapshots WHERE post_id = ? ORDER BY captured_at ASC LIMIT 1500").bind(id),
      db.prepare("SELECT * FROM post_features WHERE post_id = ? LIMIT 1").bind(id),
      db.prepare("SELECT * FROM predictions WHERE post_id = ? ORDER BY made_at DESC LIMIT 30").bind(id),
      db.prepare("SELECT * FROM alerts WHERE post_id = ? ORDER BY fired_at DESC LIMIT 30").bind(id),
      db.prepare("SELECT * FROM recreations WHERE post_id = ? ORDER BY created_at DESC LIMIT 10").bind(id),
    ]);
    const postRow = postResult.results[0] as Record<string, unknown> | undefined;
    if (!postRow) return jsonError("找不到这条帖子 · Post not found", 404);
    let mediaError: string | null = null;
    const keyframes = await postKeyframes(id).catch(() => { mediaError = "关键帧暂时无法读取 · Keyframes temporarily unavailable"; return []; });
    const response: PostDetailData = {
      keyframes,
      mediaError,
      post: rowToPost(postRow),
      snapshots: snapshotsResult.results.map((row) => rowToSnapshot(row as Record<string, unknown>)),
      features: rowToFeature(featureResult.results[0] as Record<string, unknown> | undefined ?? null),
      predictions: predictionsResult.results.map((row) => rowToPrediction(row as Record<string, unknown>)),
      alerts: alertsResult.results.map((row) => rowToAlert(row as Record<string, unknown>)),
      recreations: recreationsResult.results.map((row) => rowToRecreation(row as Record<string, unknown>)),
    };
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("post detail read failed", error);
    return jsonError("暂时无法读取帖子 · Could not load the post", 503);
  }
}

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  if (!id || id.length > 100 || id.startsWith("demo-")) return jsonError("只能重试真实帖子 · Only real posts can be retried", 400);
  try {
    const db = getD1();
    const post = await db.prepare("SELECT id, url, market, project_tag FROM posts WHERE id = ? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!post) return jsonError("找不到这条帖子 · Post not found", 404);
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    await db.batch([
      db.prepare("UPDATE posts SET analysis_state = 'queued', updated_at = ? WHERE id = ?").bind(now, id),
      db.prepare(`INSERT INTO jobs (id, kind, payload_json, status, run_at, attempts, created_at, updated_at)
        VALUES (?, 'analyze', ?, 'queued', ?, 0, ?, ?)`).bind(jobId, JSON.stringify({ postId: id, url: post.url, market: post.market, projectTag: post.project_tag }), now, now, now),
    ]);
    return Response.json({ jobId, status: "queued" }, { status: 202 });
  } catch (error) {
    console.error("post retry failed", error);
    return jsonError("暂时无法重新排队 · Could not requeue", 503);
  }
}

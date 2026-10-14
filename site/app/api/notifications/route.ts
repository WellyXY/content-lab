import { getD1, jsonError } from "@/lib/server/content-db";
import { buildNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/** Recent events worth telling the owner about: signals, finished recreations, new posts and finished analyses. */
export async function GET() {
  try {
    const db = getD1();
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const [alerts, recreations, posts, analyses] = await db.batch([
      db.prepare("SELECT id, post_id, rule, fired_at, payload_json FROM alerts WHERE fired_at >= ? ORDER BY fired_at DESC LIMIT 60").bind(since),
      db.prepare(`SELECT r.id, r.post_id, r.status, r.updated_at, p.creator_handle FROM recreations r LEFT JOIN posts p ON p.id = r.post_id
        WHERE r.updated_at >= ? AND r.status IN ('complete', 'failed') ORDER BY r.updated_at DESC LIMIT 30`).bind(since),
      db.prepare("SELECT id, bound_at, market, creator_handle FROM posts WHERE bound_at >= ? ORDER BY bound_at DESC LIMIT 300").bind(since),
      db.prepare(`SELECT f.post_id, f.created_at, p.creator_handle FROM post_features f JOIN posts p ON p.id = f.post_id
        WHERE f.created_at >= ? ORDER BY f.created_at DESC LIMIT 300`).bind(since),
    ]);
    const items = buildNotifications({
      alerts: alerts.results as never, recreations: recreations.results as never, posts: posts.results as never, analyses: analyses.results as never,
    });
    return Response.json({ items }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("notifications read failed", error);
    return jsonError("暂时无法读取通知 · Could not load notifications", 503);
  }
}

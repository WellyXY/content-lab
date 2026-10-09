import { getD1, jsonError } from "@/lib/server/content-db";
import { insertRecreationSql, RECREATIONS_PER_POST } from "@/lib/server/recreations";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  if (!id || id.length > 100) return jsonError("帖子 ID 不正确 · Invalid post ID", 400);
  try {
    const db = getD1();
    const post = await db.prepare("SELECT id, post_type, analysis_state FROM posts WHERE id = ? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!post) return jsonError("找不到这条帖子 · Post not found", 404);
    if (post.post_type === "photo") return jsonError("图集暂不支持重制 · Carousels cannot be recreated yet", 400);
    if (post.analysis_state !== "complete") return jsonError("分析完成后才能重制 · Recreate after the analysis completes", 400);
    const recreationId = crypto.randomUUID();
    const now = new Date().toISOString();
    // One transaction: the job exists only if the capped insert succeeded.
    const [inserted] = await db.batch([
      db.prepare(insertRecreationSql).bind(recreationId, id, now, now, id, RECREATIONS_PER_POST),
      db.prepare(`INSERT INTO jobs (id, kind, payload_json, status, run_at, attempts, created_at, updated_at)
        SELECT ?, 'recreate', ?, 'queued', ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM recreations WHERE id = ?)`)
        .bind(crypto.randomUUID(), JSON.stringify({ recreationId, postId: id }), now, now, now, recreationId),
    ]);
    if (!inserted?.meta.changes) return jsonError(`每条帖子最多重制 ${RECREATIONS_PER_POST} 次 · At most ${RECREATIONS_PER_POST} recreations per post`, 409);
    const used = await db.prepare("SELECT COALESCE(SUM(counts), 0) AS used FROM recreations WHERE post_id = ?").bind(id).first<{ used: number }>();
    return Response.json({ recreationId, status: "queued", remaining: Math.max(0, RECREATIONS_PER_POST - Number(used?.used ?? 0)) }, { status: 202 });
  } catch (error) {
    console.error("recreate request failed", error);
    return jsonError("暂时无法开始重制 · Could not start the recreation", 503);
  }
}

import { createDemoPosts } from "@/lib/content-lab";
import { getD1, integer, safeJson } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getD1().prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all();
    return Response.json({
      mode: result.results.length ? "live" : "demo",
      jobs: result.results.length ? result.results.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id), kind: String(row.kind), status: String(row.status), attempts: integer(row.attempts),
          payload: safeJson<Record<string, unknown>>(row.payload_json, {}), lastError: typeof row.last_error === "string" ? row.last_error : null,
          createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        };
      }) : createDemoPosts().slice(0, 3).map((post, index) => ({
        id: `demo-job-${index}`, kind: "bind", status: index === 0 ? "processing" : "queued", attempts: index === 0 ? 1 : 0,
        payload: { postId: post.id, url: post.url, market: post.market }, lastError: null, createdAt: post.boundAt, updatedAt: post.boundAt,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("jobs read failed", error);
    return Response.json({ mode: "demo", jobs: [] });
  }
}

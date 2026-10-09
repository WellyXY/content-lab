import { getD1, integer, jsonError, safeJson } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getD1().prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all();
    return Response.json({
      mode: "live",
      jobs: result.results.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id), kind: String(row.kind), status: String(row.status), attempts: integer(row.attempts),
          payload: safeJson<Record<string, unknown>>(row.payload_json, {}), lastError: typeof row.last_error === "string" ? row.last_error : null,
          createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        };
      }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("jobs read failed", error);
    return jsonError("暂时无法读取处理队列 · Could not load the queue", 503);
  }
}

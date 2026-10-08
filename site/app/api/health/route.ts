import { getD1 } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const worker = await getD1().prepare("SELECT id, last_seen_at, queue_depth FROM workers ORDER BY last_seen_at DESC LIMIT 1").first<Record<string, unknown>>();
    const lastSeenAt = typeof worker?.last_seen_at === "string" ? worker.last_seen_at : null;
    return Response.json({
      ok: true,
      site: "content-lab",
      worker: {
        connected: lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() < 480_000 : false,
        id: worker?.id ?? null,
        lastSeenAt,
        queueDepth: Number(worker?.queue_depth ?? 0),
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, site: "content-lab", worker: { connected: false } }, { status: 503 });
  }
}

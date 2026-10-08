import { z } from "zod";

import { getD1, jsonError, requireWorker } from "@/lib/server/content-db";

const schema = z.object({ workerId: z.string().min(1).max(120), version: z.string().max(80).optional(), queueDepth: z.number().int().min(0).max(100_000).default(0), details: z.record(z.string(), z.unknown()).optional() }).strict();

export async function POST(request: Request) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); } catch { return jsonError("heartbeat 格式不正確", 400); }
  const now = new Date().toISOString();
  try {
    await getD1().prepare(`INSERT INTO workers (id, version, status, queue_depth, last_seen_at, details_json) VALUES (?, ?, 'online', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, status = 'online', queue_depth = excluded.queue_depth, last_seen_at = excluded.last_seen_at, details_json = excluded.details_json`)
      .bind(body.workerId, body.version ?? null, body.queueDepth, now, JSON.stringify(body.details ?? {})).run();
    return Response.json({ ok: true, serverTime: now });
  } catch (error) {
    console.error("worker heartbeat failed", error);
    return jsonError("heartbeat 寫入失敗", 503);
  }
}

import { z } from "zod";

import { getD1, jsonError, requireWorker, safeJson } from "@/lib/server/content-db";

const schema = z.object({ workerId: z.string().min(1).max(120), limit: z.number().int().min(1).max(20).default(10), leaseSeconds: z.number().int().min(30).max(900).default(180) }).strict();

export async function POST(request: Request) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); } catch (error) { return jsonError("lease 請求格式不正確", 400, error instanceof z.ZodError ? error.flatten() : undefined); }

  try {
    const db = getD1();
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + body.leaseSeconds * 1_000).toISOString();
    const candidates = await db.prepare(`SELECT id, kind, payload_json, attempts FROM jobs
      WHERE status IN ('queued','retry') AND datetime(run_at) <= datetime('now')
        AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))
      ORDER BY run_at ASC, created_at ASC LIMIT ?`).bind(body.limit).all();
    if (!candidates.results.length) {
      await heartbeat(db, body.workerId, 0, now.toISOString());
      return Response.json({ jobs: [] });
    }
    const updates = await db.batch(candidates.results.map((raw) => {
      const row = raw as Record<string, unknown>;
      return db.prepare(`UPDATE jobs SET status = 'processing', lease_owner = ?, locked_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('queued','retry') AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))`)
        .bind(body.workerId, lockedUntil, now.toISOString(), row.id);
    }));
    const jobs = candidates.results.flatMap((raw, index) => {
      if (!updates[index]?.meta?.changes) return [];
      const row = raw as Record<string, unknown>;
      return [{ id: String(row.id), kind: String(row.kind), payload: safeJson<Record<string, unknown>>(row.payload_json, {}), attempts: Number(row.attempts ?? 0) + 1, lockedUntil }];
    });
    await heartbeat(db, body.workerId, jobs.length, now.toISOString());
    return Response.json({ jobs });
  } catch (error) {
    console.error("job lease failed", error);
    return jsonError("無法取得工作", 503);
  }
}

async function heartbeat(db: D1Database, workerId: string, queueDepth: number, now: string) {
  await db.prepare(`INSERT INTO workers (id, status, queue_depth, last_seen_at, details_json) VALUES (?, 'online', ?, ?, '{}')
    ON CONFLICT(id) DO UPDATE SET status = 'online', queue_depth = excluded.queue_depth, last_seen_at = excluded.last_seen_at`).bind(workerId, queueDepth, now).run();
}

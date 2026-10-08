import { z } from "zod";

import { getD1, integer, jsonError, requireWorker } from "@/lib/server/content-db";

const schema = z.object({
  workerId: z.string().min(1).max(120),
  error: z.string().min(1).max(2_000),
  retryAfterSeconds: z.number().int().min(10).max(86_400).default(60),
  retryable: z.boolean().optional(),
}).strict();
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); } catch { return jsonError("失敗回報格式不正確", 400); }
  const { id } = await context.params;
  try {
    const db = getD1();
    const job = await db.prepare("SELECT attempts FROM jobs WHERE id = ? AND status = 'processing' AND lease_owner = ?").bind(id, body.workerId).first<Record<string, unknown>>();
    if (!job) return jsonError("工作租約已失效", 409);
    const attempts = integer(job.attempts);
    const terminal = body.retryable === false || attempts >= 5;
    const now = new Date();
    const runAt = new Date(now.getTime() + body.retryAfterSeconds * 1_000).toISOString();
    await db.prepare(`UPDATE jobs SET status = ?, run_at = ?, lease_owner = NULL, locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(terminal ? "failed" : "retry", runAt, body.error, now.toISOString(), id).run();
    return Response.json({ id, status: terminal ? "failed" : "retry", runAt });
  } catch (error) {
    console.error("job failure update failed", error);
    return jsonError("無法回報工作失敗", 503);
  }
}

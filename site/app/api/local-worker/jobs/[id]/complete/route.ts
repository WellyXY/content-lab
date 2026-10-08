import { z } from "zod";

import { getD1, jsonError, requireWorker } from "@/lib/server/content-db";

const schema = z.object({ workerId: z.string().min(1).max(120) }).strict();
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); } catch { return jsonError("完成請求格式不正確", 400); }
  const { id } = await context.params;
  const now = new Date().toISOString();
  try {
    const result = await getD1().prepare(`UPDATE jobs SET status = 'complete', lease_owner = NULL, locked_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`).bind(now, id, body.workerId).run();
    if (!result.meta.changes) return jsonError("工作租約已失效", 409);
    return Response.json({ id, status: "complete" });
  } catch (error) {
    console.error("job complete failed", error);
    return jsonError("無法完成工作", 503);
  }
}

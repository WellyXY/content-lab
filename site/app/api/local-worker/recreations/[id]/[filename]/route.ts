import { getD1, jsonError, requireWorker } from "@/lib/server/content-db";
import { getMediaBucket } from "@/lib/server/media-storage";
import { MAX_RECREATION_BYTES, recreationKey } from "@/lib/server/recreations";

type Context = { params: Promise<{ id: string; filename: string }> };

/** The worker uploads a rendered recreation (video.mp4) and its cover (cover.jpg), or the images of a carousel copy (img-NN-V.jpg). */
export async function PUT(request: Request, context: Context) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  const { id, filename } = await context.params;
  const key = recreationKey(id, filename);
  if (!key) return jsonError("文件路径不正确 · Invalid file path", 400);
  const expected = filename === "video.mp4" ? "video/mp4" : "image/jpeg";
  if (request.headers.get("content-type")?.split(";")[0] !== expected) return jsonError(`只接受 ${expected} · ${expected} only`, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RECREATION_BYTES) return jsonError("文件超过 50 MiB · File exceeds 50 MiB", 413);
  try {
    const row = await getD1().prepare("SELECT id FROM recreations WHERE id = ? LIMIT 1").bind(id).first();
    if (!row) return jsonError("重制记录尚未同步 · Recreation not synced yet", 409);
    const reader = request.body?.getReader();
    if (!reader) return jsonError("缺少文件内容 · Missing file content", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECREATION_BYTES) { await reader.cancel(); return jsonError("文件超过 50 MiB · File exceeds 50 MiB", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const signatureOk = expected === "video/mp4"
      ? new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signatureOk) return jsonError("文件内容格式不正确 · Invalid file content", 415);
    await getMediaBucket().put(key, bytes, { httpMetadata: { contentType: expected, cacheControl: "public, max-age=31536000, immutable" } });
    return Response.json({ url: `/media/recreations/${encodeURIComponent(id)}/${filename}` });
  } catch (error) {
    console.error("recreation upload failed", error);
    return jsonError("上传失败，可重试 · Upload failed; retry", 503);
  }
}

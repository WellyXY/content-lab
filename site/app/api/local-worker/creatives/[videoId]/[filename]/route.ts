import { getD1, jsonError, requireWorker } from "@/lib/server/content-db";
import { getMediaBucket } from "@/lib/server/media-storage";
import { creativeMediaKey, MAX_CREATIVE_VIDEO_BYTES } from "@/lib/server/creative-media";

type Context = { params: Promise<{ videoId: string; filename: string }> };

/** The worker uploads a regular ad creative's video (video.mp4) and a cover taken from it (cover.jpg). */
export async function PUT(request: Request, context: Context) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  const { videoId, filename } = await context.params;
  const key = creativeMediaKey(videoId, filename);
  if (!key) return jsonError("文件路径不正确 · Invalid file path", 400);
  const expected = filename.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
  if (request.headers.get("content-type")?.split(";")[0] !== expected) return jsonError(`只接受 ${expected} · ${expected} only`, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_CREATIVE_VIDEO_BYTES) return jsonError("文件超过 50 MiB · File exceeds 50 MiB", 413);
  try {
    const row = await getD1().prepare("SELECT video_id FROM creatives WHERE video_id = ? LIMIT 1").bind(videoId).first();
    if (!row) return jsonError("素材尚未同步 · Creative not synced yet", 409);
    const reader = request.body?.getReader();
    if (!reader) return jsonError("缺少文件内容 · Missing file content", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CREATIVE_VIDEO_BYTES) { await reader.cancel(); return jsonError("文件超过 50 MiB · File exceeds 50 MiB", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const signatureOk = expected === "video/mp4" ? new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signatureOk) return jsonError("文件内容格式不正确 · Invalid file content", 415);
    // A new upload replaces the old file: the URL carries a version so browsers and caches fetch it again.
    await getMediaBucket().put(key, bytes, { httpMetadata: { contentType: expected, cacheControl: "public, max-age=86400" } });
    return Response.json({ url: `/media/creatives/${encodeURIComponent(videoId)}/${filename}?v=${Date.now().toString(36)}` });
  } catch (error) {
    console.error("creative upload failed", error);
    return jsonError("上传失败，可重试 · Upload failed; retry", 503);
  }
}

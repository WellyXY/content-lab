import { getD1, jsonError, requireWorker } from "@/lib/server/content-db";
import { getMediaBucket, MAX_FRAME_BYTES, mediaKey } from "@/lib/server/media-storage";

type Context = { params: Promise<{ postId: string; filename: string }> };
export async function PUT(request: Request, context: Context) {
  const rejected = requireWorker(request);
  if (rejected) return rejected;
  const { postId, filename } = await context.params;
  const key = mediaKey(postId, filename);
  if (!key) return jsonError("媒體路徑不正確", 400);
  const mime = request.headers.get("content-type")?.split(";")[0];
  if (!mime || !["image/jpeg", "image/png", "image/webp"].includes(mime)) return jsonError("只接受圖片", 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FRAME_BYTES) return jsonError("圖片超過 5 MiB", 413);
  try {
    const post = await getD1().prepare("SELECT id FROM posts WHERE id = ? LIMIT 1").bind(postId).first();
    if (!post) return jsonError("帖子尚未同步", 409);
    const reader = request.body?.getReader();
    if (!reader) return jsonError("缺少圖片內容", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAME_BYTES) { await reader.cancel(); return jsonError("圖片超過 5 MiB", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const signatureOk = mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/png" ? [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)
      : new TextDecoder().decode(bytes.slice(0,4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8,12)) === "WEBP";
    if (!signatureOk) return jsonError("圖片內容格式不正確", 415);
    await getMediaBucket().put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" } });
    return Response.json({ url: `/media/${encodeURIComponent(postId)}/${encodeURIComponent(filename)}` });
  } catch (error) {
    console.error("frame upload failed", error);
    return jsonError("圖片同步失敗，可重試", 503);
  }
}

import { jsonError } from "@/lib/server/content-db";
import { getMediaBucket } from "@/lib/server/media-storage";
import { creativeMediaKey } from "@/lib/server/creative-media";

/** Public read of a regular ad creative's video or cover; byte ranges let the video player seek. */
export async function GET(request: Request, context: { params: Promise<{ videoId: string; filename: string }> }) {
  const { videoId, filename } = await context.params;
  const key = creativeMediaKey(videoId, filename);
  if (!key) return jsonError("找不到文件 · File not found", 404);
  try {
    const bucket = getMediaBucket();
    const match = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const head = await bucket.head(key);
      if (!head) return jsonError("找不到文件 · File not found", 404);
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
      if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
      const part = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!part) return jsonError("找不到文件 · File not found", 404);
      const headers = new Headers({ "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${head.size}`, "content-length": String(end - start + 1), "x-content-type-options": "nosniff" });
      part.writeHttpMetadata(headers);
      return new Response(part.body, { status: 206, headers });
    }
    const object = await bucket.get(key);
    if (!object) return jsonError("找不到文件 · File not found", 404);
    const headers = new Headers({ "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("creative media read failed", error);
    return jsonError("文件暂时无法读取 · File temporarily unavailable", 503);
  }
}

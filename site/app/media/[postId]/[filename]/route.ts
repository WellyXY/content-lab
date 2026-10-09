import { jsonError } from "@/lib/server/content-db";
import { getMediaBucket, mediaKey } from "@/lib/server/media-storage";

export async function GET(request: Request, context: { params: Promise<{ postId: string; filename: string }> }) {
  const { postId, filename } = await context.params;
  const key = mediaKey(postId, filename);
  if (!key) return jsonError("找不到图片 · Image not found", 404);
  try {
    const object = await getMediaBucket().get(key);
    if (!object) return jsonError("找不到图片 · Image not found", 404);
    const headers = new Headers({ "x-content-type-options": "nosniff" });
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("frame read failed", error);
    return jsonError("图片暂时无法读取 · Image temporarily unavailable", 503);
  }
}

import { runtimeEnv } from "@/lib/server/content-db";

export const MAX_FRAME_BYTES = 5 * 1024 * 1024;
export function mediaKey(postId: string, filename: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(postId) || !/^[a-zA-Z0-9_-]{1,150}\.(jpg|jpeg|png|webp)$/.test(filename)) return null;
  return `frames/${postId}/${filename}`;
}
export function getMediaBucket(): R2Bucket {
  const bucket = runtimeEnv().BUCKET;
  if (!bucket) throw new Error("媒体存储暂时无法使用 · Media storage unavailable");
  return bucket;
}
export async function postKeyframes(postId: string): Promise<string[]> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(postId)) return [];
  const result = await getMediaBucket().list({ prefix: `frames/${postId}/`, limit: 100 });
  return result.objects.sort((a, b) => a.key.localeCompare(b.key)).slice(0, 12)
    .map((item) => `/media/${encodeURIComponent(postId)}/${encodeURIComponent(item.key.split("/").at(-1)!)}`);
}

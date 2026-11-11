import { writeFileSync } from "node:fs";

import type { ContentLabDatabase } from "../db/database.js";
import type { MetricsProvider } from "../providers/metrics.js";

const MAX_MUSIC_BYTES = 20 * 1024 * 1024;

/** Download the sound of a tracked post to `dest`. The link is signed and short-lived, so it is fetched fresh each time. */
export async function downloadPostMusic(db: ContentLabDatabase, provider: MetricsProvider, postId: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const post = db.prepare("SELECT url FROM posts WHERE id=?").get(postId) as { url: string } | undefined;
  if (!post) return null;
  const { metadata } = await provider.fetchPost(post.url);
  if (!metadata.musicUrl) return null;
  const response = await fetchImpl(metadata.musicUrl, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000 || bytes.length > MAX_MUSIC_BYTES) return null;
  writeFileSync(dest, bytes);
  return dest;
}

// Kept free of runtime imports so node:test can load it.
export const MAX_CREATIVE_VIDEO_BYTES = 50 * 1024 * 1024;

/** A regular ad creative keeps its video and a cover taken from it. */
export function creativeMediaKey(videoId: string, filename: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(videoId) || !["video.mp4", "cover.jpg"].includes(filename)) return null;
  return `creatives/${videoId}/${filename}`;
}

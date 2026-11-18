import { execFile } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ContentLabDatabase } from "../db/database.js";
import { download } from "../analyzer/media.js";
import { syncCreative, type VideoInfo } from "./sync.js";
import { creativeMediaId } from "./analyze.js";

const execFileAsync = promisify(execFile);

/** Videos per job: one video-info call each, and a few minutes of downloads and uploads. */
export const CREATIVE_MEDIA_BATCH = 30;
export const CREATIVE_MEDIA_MAX_ATTEMPTS = 3;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export interface CreativeMediaDeps {
  /** Fresh details (with a short-lived preview link) for some of one account's videos. */
  videoInfo: (advertiserId: string, videoIds: string[]) => Promise<VideoInfo[]>;
  upload: (videoId: string, filename: "video.mp4" | "cover.jpg", path: string) => Promise<string>;
  download?: (url: string, target: string) => Promise<void>;
  /** Writes a cover chosen from the video's opening seconds. */
  pickCover?: (video: string, target: string) => Promise<void>;
}

/** Creatives whose video is not on the Site yet, largest 30-day spend first, grouped into per-account batches. */
export function creativeMediaBatches(db: ContentLabDatabase, limit = 1_000): Array<{ advertiserId: string; videoIds: string[] }> {
  const rows = db.prepare(`
    SELECT c.video_id, c.advertiser_id FROM creatives c
    LEFT JOIN (SELECT video_id, SUM(spend) AS spend FROM creative_stats WHERE window_days=30 GROUP BY video_id) s ON s.video_id=c.video_id
    WHERE c.video_url IS NULL AND c.file_name IS NOT NULL AND c.media_attempts < ? AND s.spend > 0
    ORDER BY s.spend DESC LIMIT ?
  `).all(CREATIVE_MEDIA_MAX_ATTEMPTS, limit) as Array<{ video_id: string; advertiser_id: string }>;
  const byAccount = new Map<string, string[]>();
  for (const row of rows) byAccount.set(row.advertiser_id, [...(byAccount.get(row.advertiser_id) ?? []), row.video_id]);
  return [...byAccount].flatMap(([advertiserId, ids]) => Array.from({ length: Math.ceil(ids.length / CREATIVE_MEDIA_BATCH) }, (_, index) => ({ advertiserId, videoIds: ids.slice(index * CREATIVE_MEDIA_BATCH, (index + 1) * CREATIVE_MEDIA_BATCH) })));
}

/** TikTok's own cover is often the blank first frame: take the most representative frame of the first six seconds. */
export async function pickCoverFrame(video: string, target: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-v", "error", "-y", "-t", "6", "-i", video, "-vf", "thumbnail=90,scale=540:-2", "-frames:v", "1", "-q:v", "3", target], { timeout: 60_000 });
}

/** Download each video, choose a cover from it, and put both on the Site. A failure is retried in a later batch. */
export async function syncCreativeMedia(db: ContentLabDatabase, mediaDir: string, batch: { advertiserId: string; videoIds: string[] }, deps: CreativeMediaDeps): Promise<{ uploaded: number; failed: number }> {
  const fetchVideo = deps.download ?? download;
  const pickCover = deps.pickCover ?? pickCoverFrame;
  const infos = new Map((await deps.videoInfo(batch.advertiserId, batch.videoIds)).map((info) => [info.videoId, info]));
  let uploaded = 0;
  let failed = 0;
  for (const videoId of batch.videoIds) {
    const dir = join(mediaDir, creativeMediaId(videoId));
    const video = join(dir, "source.mp4");
    const cover = join(dir, "cover-frame.jpg");
    try {
      const url = infos.get(videoId)?.previewUrl;
      if (!url) throw new Error("No preview link for this video");
      mkdirSync(dir, { recursive: true });
      await fetchVideo(url, video);
      if (statSync(video).size > MAX_VIDEO_BYTES) throw new Error("Video exceeds 50 MiB");
      await pickCover(video, cover);
      const videoUrl = await deps.upload(videoId, "video.mp4", video);
      const coverUrl = await deps.upload(videoId, "cover.jpg", cover);
      db.prepare("UPDATE creatives SET video_url=?, cover_url=?, updated_at=? WHERE video_id=?").run(videoUrl, coverUrl, new Date().toISOString(), videoId);
      syncCreative(db, videoId);
      uploaded += 1;
    } catch {
      db.prepare("UPDATE creatives SET media_attempts=media_attempts+1 WHERE video_id=?").run(videoId);
      failed += 1;
    } finally {
      // The Site keeps the video; the local copy is only needed for the cover.
      rmSync(video, { force: true });
    }
  }
  return { uploaded, failed };
}

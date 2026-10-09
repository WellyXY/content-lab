import { execFile } from "node:child_process";
import { mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { HYPERFRAMES_BIN, HYPERFRAMES_ENV } from "./workspace.js";

const execFileAsync = promisify(execFile);
export const MAX_RECREATION_BYTES = 50 * 1024 * 1024;
export interface Rendition { videoPath: string; coverPath: string; durationS: number; bytes: number }

export async function verifyRendition(path: string, sourceDurationS: number): Promise<{ durationS: number }> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path]);
  const info = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration?: string } };
  const video = info.streams.find((stream) => stream.codec_type === "video");
  if (!video || video.width !== 1080 || video.height !== 1920) throw new Error(`Rendition must be 1080x1920, got ${video?.width}x${video?.height}`);
  if (!info.streams.some((stream) => stream.codec_type === "audio")) throw new Error("Rendition has no audio track");
  const durationS = Number(info.format.duration ?? 0);
  if (durationS < 5) throw new Error(`Rendition must last at least 5 s, got ${durationS.toFixed(1)} s`);
  if (sourceDurationS > 0 && durationS > sourceDurationS + 0.5) throw new Error(`Rendition (${durationS.toFixed(1)} s) is longer than the source (${sourceDurationS.toFixed(1)} s)`);
  return { durationS };
}

async function hyperframesRender(dir: string, out: string): Promise<void> {
  await execFileAsync(HYPERFRAMES_BIN, ["render", "--quality", "delivery", "--output", out], { cwd: dir, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...HYPERFRAMES_ENV } });
}

export async function renderRecreation(dir: string, sourceDurationS: number, deps: { render?: (dir: string, out: string) => Promise<void> } = {}): Promise<Rendition> {
  mkdirSync(join(dir, "renders"), { recursive: true });
  const videoPath = join(dir, "renders", "final.mp4");
  await (deps.render ?? hyperframesRender)(dir, videoPath);
  let { durationS } = await verifyRendition(videoPath, sourceDurationS);
  if (statSync(videoPath).size > MAX_RECREATION_BYTES) {
    const smaller = join(dir, "renders", "final-crf26.mp4");
    await execFileAsync("ffmpeg", ["-loglevel", "error", "-y", "-i", videoPath, "-c:v", "libx264", "-crf", "26", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", smaller], { timeout: 10 * 60_000 });
    renameSync(smaller, videoPath);
    ({ durationS } = await verifyRendition(videoPath, sourceDurationS));
    if (statSync(videoPath).size > MAX_RECREATION_BYTES) throw new Error("Rendition is larger than 50 MB after re-encoding");
  }
  const coverPath = join(dir, "renders", "cover.jpg");
  await execFileAsync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(Math.min(1, durationS / 2)), "-i", videoPath, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", coverPath], { timeout: 60_000 });
  return { videoPath, coverPath, durationS, bytes: statSync(videoPath).size };
}

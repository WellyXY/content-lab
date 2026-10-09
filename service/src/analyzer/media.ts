import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MANIFEST = "frames-v2.json";

export const MAX_VIDEO_FRAMES = 12;
export const MAX_CAROUSEL_IMAGES = 20;

export interface Keyframe {
  file: string;
  /** Seconds into the video; null for carousel images. */
  timeS: number | null;
  /** 1-based position in a photo carousel; null for video frames. */
  imageIndex: number | null;
}

export interface MediaFacts {
  durationS: number | null;
  width: number | null;
  height: number | null;
  /** Hard cuts detected over the whole video (scene score > 0.3). */
  sceneCuts: number | null;
  /** Images in the carousel, including any beyond the analysis limit. */
  imageCount: number | null;
}

export interface PreparedMedia { frames: Keyframe[]; facts: MediaFacts }

export interface MediaPost {
  id: string;
  type: string | null;
  media_url: string | null;
  image_urls_json?: string | null;
  duration_s: number | null;
}

/**
 * Spread frames over the whole video: start at the opening, then repeatedly add
 * the time farthest from every frame chosen so far, preferring scene changes
 * over evenly spaced fill-in points.
 */
export function chooseFrameTimes(durationS: number, sceneTimes: number[], max = MAX_VIDEO_FRAMES): number[] {
  if (!(durationS > 0)) return [0];
  const end = Math.max(0, durationS - 0.2);
  const tenth = (value: number): number => Math.round(value * 10) / 10;
  const cuts = [...new Set(sceneTimes.filter((time) => time > 0.3 && time < end).map((time) => tenth(time + 0.15)))];
  const grid = Array.from({ length: max * 2 }, (_, index) => tenth(((index + 0.5) * end) / (max * 2)));
  const candidates = [...cuts.map((time) => ({ time, weight: 1.5 })), ...grid.map((time) => ({ time, weight: 1 }))];
  const picked = [0];
  while (picked.length < max) {
    let best: { time: number; score: number; gap: number } | null = null;
    for (const candidate of candidates) {
      const gap = Math.min(...picked.map((time) => Math.abs(time - candidate.time)), Math.abs(end - candidate.time) * 2);
      const score = gap * candidate.weight;
      if (!best || score > best.score) best = { time: candidate.time, score, gap };
    }
    if (!best || best.gap < 0.75) break;
    picked.push(best.time);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** Parse `pts_time:` values that ffmpeg's showinfo filter writes to stderr. */
export function parseShowinfoTimes(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:\s*([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
}

export function validateMediaUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const allowedSuffixes = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "byteoversea.com", "ibytedtos.com", "muscdn.com", "tikwm.com", "akamaized.net"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new Error("Provider returned an untrusted media URL");
  }
  return url.toString();
}

async function fetchTrustedMedia(raw: string, signal: AbortSignal): Promise<Response> {
  let url = validateMediaUrl(raw);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, { signal, redirect: "manual", headers: { "user-agent": "ContentLab/0.1" } });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Media CDN returned a redirect without a location");
    url = validateMediaUrl(new URL(location, url).toString());
  }
  throw new Error("Media CDN exceeded the redirect limit");
}

async function download(raw: string, target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchTrustedMedia(raw, controller.signal);
    if (!response.ok || !response.body) throw new Error(`Media download returned ${response.status}`);
    if (Number(response.headers.get("content-length") ?? "0") > MAX_MEDIA_BYTES) throw new Error("Media exceeds the 100 MB limit");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_MEDIA_BYTES) { await reader.cancel(); throw new Error("Media exceeds the 100 MB limit"); }
      chunks.push(next.value);
    }
    if (total === 0) throw new Error("Media download returned an empty file");
    writeFileSync(target, Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

async function probe(source: string): Promise<Pick<MediaFacts, "durationS" | "width" | "height">> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", source], { timeout: 30_000 });
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const duration = Number(parsed.format?.duration);
  return { durationS: Number.isFinite(duration) ? duration : null, width: parsed.streams?.[0]?.width ?? null, height: parsed.streams?.[0]?.height ?? null };
}

async function sceneTimes(source: string, threshold: number): Promise<number[]> {
  const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-i", source, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"], { timeout: 3 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  return parseShowinfoTimes(stderr);
}

function clearFrames(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (/^(frame|kf|img)-.*\.(jpe?g|png|webp)$/i.test(name) || name === MANIFEST) rmSync(join(directory, name), { force: true });
  }
}

function readManifest(directory: string): PreparedMedia | null {
  const path = join(directory, MANIFEST);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PreparedMedia;
  return manifest.frames.every((frame) => existsSync(join(directory, frame.file))) && manifest.frames.length > 0 ? manifest : null;
}

/** Download a post's media once and extract timestamped keyframes or every carousel image. */
export async function prepareMedia(mediaDir: string, post: MediaPost): Promise<PreparedMedia> {
  const directory = join(mediaDir, post.id);
  mkdirSync(directory, { recursive: true });
  const cached = readManifest(directory);
  if (cached) return cached;
  clearFrames(directory);

  if (post.type === "photo") {
    const listed = post.image_urls_json ? JSON.parse(post.image_urls_json) as string[] : [];
    const urls = listed.length > 0 ? listed : post.media_url ? [post.media_url] : [];
    if (urls.length === 0) throw new Error("This carousel has no image URLs yet");
    const frames: Keyframe[] = [];
    for (const [index, url] of urls.slice(0, MAX_CAROUSEL_IMAGES).entries()) {
      const source = join(directory, `source-image-${index + 1}`);
      await download(url, source);
      const file = `img-${String(index + 1).padStart(2, "0")}.jpg`;
      await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vf", "scale='min(1080,iw)':-2", "-frames:v", "1", "-q:v", "3", join(directory, file)], { timeout: 60_000 });
      rmSync(source, { force: true });
      frames.push({ file, timeS: null, imageIndex: index + 1 });
    }
    const prepared: PreparedMedia = { frames, facts: { durationS: null, width: null, height: null, sceneCuts: null, imageCount: urls.length } };
    writeFileSync(join(directory, MANIFEST), JSON.stringify(prepared));
    return prepared;
  }

  const source = join(directory, "source.mp4");
  if (!existsSync(source)) {
    if (!post.media_url) throw new Error("This video has no downloadable media yet");
    await download(post.media_url, source);
  }
  const probed = await probe(source);
  const durationS = probed.durationS ?? post.duration_s ?? 0;
  const cuts = await sceneTimes(source, 0.3);
  const candidates = cuts.length >= 3 ? cuts : await sceneTimes(source, 0.2);
  const frames: Keyframe[] = [];
  for (const [index, time] of chooseFrameTimes(durationS, candidates).entries()) {
    const file = `kf-${String(index + 1).padStart(2, "0")}.jpg`;
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", source, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", join(directory, file)], { timeout: 60_000 });
    if (existsSync(join(directory, file))) frames.push({ file, timeS: time, imageIndex: null });
  }
  if (frames.length === 0) throw new Error("No keyframes could be extracted from the video");
  const prepared: PreparedMedia = { frames, facts: { ...probed, durationS, sceneCuts: cuts.length, imageCount: null } };
  writeFileSync(join(directory, MANIFEST), JSON.stringify(prepared));
  return prepared;
}

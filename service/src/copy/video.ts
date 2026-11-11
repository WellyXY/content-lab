import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Seconds each image is shown, as TikTok plays a photo post; a short carousel still lasts MIN_SECONDS. */
export const SECONDS_PER_IMAGE = 3;
const MIN_SECONDS = 6;
export const slideshowSeconds = (images: number): number => Math.max(MIN_SECONDS, images * SECONDS_PER_IMAGE);

/**
 * A photo carousel as the video TikTok plays: each image in turn on a 1080x1920 frame (fitted, over a blurred fill
 * of itself), with the post's music looped and faded out at the end. Without music the soundtrack is silent.
 */
export async function carouselVideo(images: string[], musicPath: string | null, output: string): Promise<{ durationS: number }> {
  if (!images.length) throw new Error("A carousel video needs at least one image");
  const total = slideshowSeconds(images.length);
  const each = total / images.length;
  const inputs = images.flatMap((image) => ["-loop", "1", "-t", String(each), "-i", image]);
  const frames = images.map((_, index) => `[${index}:v]split[a${index}][b${index}];`
    + `[a${index}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:6[bg${index}];`
    + `[b${index}]scale=1080:1920:force_original_aspect_ratio=decrease[fg${index}];`
    + `[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[v${index}]`).join(";");
  const audioIndex = images.length;
  const audio = musicPath
    ? ["-stream_loop", "-1", "-i", musicPath]
    : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
  const fade = musicPath ? `;[${audioIndex}:a]atrim=0:${total},afade=t=out:st=${Math.max(0, total - 0.6)}:d=0.6[a]` : `;[${audioIndex}:a]atrim=0:${total}[a]`;
  const filter = `${frames};${images.map((_, index) => `[v${index}]`).join("")}concat=n=${images.length}:v=1:a=0[v]${fade}`;
  await execFileAsync("ffmpeg", ["-v", "error", "-y", ...inputs, ...audio, "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-t", String(total), "-movflags", "+faststart", output], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { durationS: total };
}

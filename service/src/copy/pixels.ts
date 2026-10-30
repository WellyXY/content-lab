import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** An RGB image in memory: three bytes per pixel, row by row. */
export interface Rgb { width: number; height: number; data: Buffer }

export async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path]);
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error(`Could not read the size of ${path}`);
  return { width, height };
}

/** Decode an image; with a size, scale it to fill that size and crop the overflow (keeping the centre). */
export async function readRgb(path: string, size?: { width: number; height: number }): Promise<Rgb> {
  const target = size ?? await imageSize(path);
  const filter = size ? ["-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`] : [];
  const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", path, ...filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (stdout.length !== target.width * target.height * 3) throw new Error(`Decoded ${path} to ${stdout.length} bytes, expected ${target.width}x${target.height}`);
  return { ...target, data: stdout };
}

export async function writeJpeg(path: string, image: Rgb): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${image.width}x${image.height}`, "-i", "-", "-frames:v", "1", "-q:v", "2", path], (error) => error ? reject(error) : resolve());
    child.stdin?.end(image.data);
  });
}

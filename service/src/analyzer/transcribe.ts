import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Transcript {
  text: string;
  language: string | null;
  model: string;
}

interface WhisperSegment { text?: string; no_speech_prob?: number }
interface WhisperOutput { text?: string; language?: string; segments?: WhisperSegment[] }

/**
 * Whisper invents text over music-only clips; keep a transcript only when the
 * segments look like real speech.
 */
export function acceptTranscript(output: WhisperOutput, model: string): Transcript | null {
  const text = (output.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 4) return null;
  const segments = output.segments ?? [];
  if (segments.length > 0) {
    const silence = segments.reduce((sum, segment) => sum + (segment.no_speech_prob ?? 0), 0) / segments.length;
    if (silence > 0.6) return null;
  }
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const peak = Math.max(...counts.values()) / tokens.length;
  if (tokens.length >= 8 && (peak > 0.3 || counts.size / tokens.length < 0.25)) return null;
  return { text: text.slice(0, 4_000), language: output.language ?? null, model };
}

/** Transcribe a post's source video once and cache the result next to its frames. */
export async function transcribePost(postDir: string, model: string, binary = "whisper"): Promise<Transcript | null> {
  const source = join(postDir, "source.mp4");
  const cache = join(postDir, `transcript-${model}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Transcript | null;
  if (!existsSync(source)) return null;
  const output = mkdtempSync(join(tmpdir(), "content-lab-whisper-"));
  try {
    await execFileAsync(binary, [
      source, "--model", model, "--output_format", "json", "--output_dir", output,
      "--fp16", "False", "--verbose", "False", "--task", "transcribe",
    ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    const result = acceptTranscript(JSON.parse(readFileSync(join(output, "source.json"), "utf8")) as WhisperOutput, model);
    writeFileSync(cache, JSON.stringify(result));
    return result;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

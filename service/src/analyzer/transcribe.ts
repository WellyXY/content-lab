import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TranscriptSegment { startS: number; endS: number; text: string }

export interface Transcript {
  text: string;
  language: string | null;
  model: string;
  /** Timed lines, so the script can place each spoken line in its segment. */
  segments: TranscriptSegment[];
}

interface WhisperSegment { start?: number; end?: number; text?: string; no_speech_prob?: number }
interface WhisperOutput { text?: string; language?: string; segments?: WhisperSegment[] }

/** Lines Whisper is known to invent over music or silence, in the markets' languages. */
const HALLUCINATIONS = /thanks? (?:you )?for watching|please subscribe|like and subscribe|subscribe to|altyaz[ıi]|abone ol|izlediğiniz için teşekkürler|đăng ký kênh|cảm ơn các bạn đã (?:xem|theo dõi)|terima kasih (?:telah|sudah) menonton|ขอบคุณที่รับชม|شكرا للمشاهدة|ご視聴|字幕|♪+/gi;

/** Languages each market's creators actually speak; a short clip in any other language is usually invented. */
export const MARKET_LANGUAGES: Record<string, string[]> = { TR: ["tr"], VN: ["vi"], ID: ["id", "jw", "su", "ms"], TH: ["th"], GCC: ["ar", "en"], IQ: ["ar", "en"], PH: ["tl", "en"] };

/**
 * Whisper invents text over music-only clips; keep a transcript only when the
 * segments look like real speech.
 */
export function acceptTranscript(output: WhisperOutput, model: string, expectedLanguages: string[] = []): Transcript | null {
  const text = (output.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 4) return null;
  if (text.replace(HALLUCINATIONS, "").replace(/[\s\p{P}]/gu, "").length < 4) return null;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (expectedLanguages.length && output.language && !expectedLanguages.includes(output.language) && wordCount < 15) return null;
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
  const timed = segments.flatMap((segment): TranscriptSegment[] => {
    const line = (segment.text ?? "").replace(/\s+/g, " ").trim();
    if (!line || typeof segment.start !== "number" || typeof segment.end !== "number") return [];
    if ((segment.no_speech_prob ?? 0) > 0.8) return [];
    return [{ startS: Math.round(segment.start * 10) / 10, endS: Math.round(segment.end * 10) / 10, text: line }];
  });
  return { text: text.slice(0, 4_000), language: output.language ?? null, model, segments: timed.slice(0, 200) };
}

/** Transcribe a post's source video once and cache the result next to its frames. */
export async function transcribePost(postDir: string, model: string, expectedLanguages: string[] = [], binary = "whisper"): Promise<Transcript | null> {
  const source = join(postDir, "source.mp4");
  // Whisper's raw output is cached; acceptance rules are re-applied on every read.
  const cache = join(postDir, `whisper-raw-${model}.json`);
  if (existsSync(cache)) return acceptTranscript(JSON.parse(readFileSync(cache, "utf8")) as WhisperOutput, model, expectedLanguages);
  if (!existsSync(source)) return null;
  const output = mkdtempSync(join(tmpdir(), "content-lab-whisper-"));
  try {
    await execFileAsync(binary, [
      source, "--model", model, "--output_format", "json", "--output_dir", output,
      "--fp16", "False", "--verbose", "False", "--task", "transcribe",
    ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    const raw = JSON.parse(readFileSync(join(output, "source.json"), "utf8")) as WhisperOutput;
    writeFileSync(cache, JSON.stringify({ text: raw.text, language: raw.language, segments: raw.segments?.map(({ start, end, text, no_speech_prob }) => ({ start, end, text, no_speech_prob })) }));
    return acceptTranscript(raw, model, expectedLanguages);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

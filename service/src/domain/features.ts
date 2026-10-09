import type { MediaFacts } from "../analyzer/media.js";
import type { Transcript } from "../analyzer/transcribe.js";

/** Facts computed by the program, never by the model, so they stay comparable across posts. */
export interface ComputedFeatures {
  format_type: "video" | "photo";
  duration_s: number | null;
  duration_band: "<10s" | "10-20s" | "20-40s" | ">40s" | null;
  scene_cuts: number | null;
  cuts_per_10s: number | null;
  pacing_band: "slow" | "medium" | "fast" | null;
  image_count: number | null;
  has_speech: boolean;
  speech_words: number;
  speech_words_per_min: number | null;
  first_speech_s: number | null;
  speech_coverage: number | null;
  music_type: "original" | "library" | "unknown";
  on_screen_text_chars: number;
  on_screen_text_per_frame: number | null;
  caption_chars: number;
  hashtag_count: number;
  brand_in_caption: boolean;
  publish_hour_local: number | null;
  publish_weekday_local: number | null;
}

/** Local day boundaries per market; GCC uses Riyadh time. */
export const MARKET_UTC_OFFSET_HOURS: Record<string, number> = { ID: 7, VN: 7, TR: 3, GCC: 3, TH: 7 };

/** TikTok labels a creator's own audio as "original sound" in each market's language. */
const ORIGINAL_SOUND = /original sound|nhạc nền|âm thanh gốc|orijinal ses|suara asli|เสียงต้นฉบับ|الصوت الأصلي|som original|sonido original|оригинальный звук/i;

const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits;

export function durationBand(durationS: number | null): ComputedFeatures["duration_band"] {
  if (durationS === null || !(durationS > 0)) return null;
  if (durationS < 10) return "<10s";
  if (durationS < 20) return "10-20s";
  if (durationS <= 40) return "20-40s";
  return ">40s";
}

export function pacingBand(cutsPer10s: number | null): ComputedFeatures["pacing_band"] {
  if (cutsPer10s === null) return null;
  if (cutsPer10s < 1) return "slow";
  if (cutsPer10s <= 2.5) return "medium";
  return "fast";
}

export function computeFeatures(input: {
  type: string | null;
  facts: MediaFacts;
  durationS: number | null;
  transcript: Transcript | null;
  musicTitle: string | null;
  caption: string | null;
  publishedAt: string | null;
  market: string | null;
  frameTexts: string[];
  brandNames: string[];
}): ComputedFeatures {
  const photo = input.type === "photo";
  const durationS = photo ? null : input.facts.durationS ?? input.durationS;
  const cutsPer10s = !photo && durationS && input.facts.sceneCuts !== null ? round((input.facts.sceneCuts / durationS) * 10) : null;
  const words = input.transcript ? input.transcript.text.split(/\s+/).filter(Boolean).length : 0;
  const spoken = input.transcript?.segments.reduce((sum, segment) => sum + Math.max(0, segment.endS - segment.startS), 0) ?? 0;
  const textChars = input.frameTexts.reduce((sum, text) => sum + text.replace(/\s+/g, "").length, 0);
  const caption = input.caption ?? "";
  const offset = MARKET_UTC_OFFSET_HOURS[input.market?.toUpperCase() ?? ""] ?? 0;
  const published = input.publishedAt ? new Date(Date.parse(input.publishedAt) + offset * 3_600_000) : null;
  const lowerCaption = caption.toLowerCase();
  return {
    format_type: photo ? "photo" : "video",
    duration_s: durationS === null ? null : round(durationS),
    duration_band: durationBand(durationS),
    scene_cuts: photo ? null : input.facts.sceneCuts,
    cuts_per_10s: cutsPer10s,
    pacing_band: pacingBand(cutsPer10s),
    image_count: photo ? input.facts.imageCount : null,
    has_speech: words > 0,
    speech_words: words,
    speech_words_per_min: words > 0 && spoken > 0 ? Math.round((words / spoken) * 60) : null,
    first_speech_s: input.transcript?.segments[0]?.startS ?? null,
    speech_coverage: words > 0 && durationS ? round(Math.min(1, spoken / durationS), 2) : null,
    music_type: !input.musicTitle ? "unknown" : ORIGINAL_SOUND.test(input.musicTitle) ? "original" : "library",
    on_screen_text_chars: textChars,
    on_screen_text_per_frame: input.frameTexts.length ? Math.round(textChars / input.frameTexts.length) : null,
    caption_chars: [...caption].length,
    hashtag_count: (caption.match(/#[^\s#]+/g) ?? []).length,
    brand_in_caption: input.brandNames.some((name) => name.trim() && lowerCaption.includes(name.replace(/^#/, "").toLowerCase())),
    publish_hour_local: published && Number.isFinite(published.getTime()) ? published.getUTCHours() : null,
    publish_weekday_local: published && Number.isFinite(published.getTime()) ? published.getUTCDay() : null,
  };
}

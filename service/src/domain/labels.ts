import { existsSync, readFileSync } from "node:fs";

export type Lang = "zh" | "en";
type Pair = [string, string];

interface LabelFile {
  dimensions: Record<string, Pair>;
  values: Record<string, Record<string, Pair>>;
  computed: Record<string, { label: Pair; values?: Record<string, Pair> }>;
}

const cache = new Map<string, LabelFile>();

/** Bilingual display labels; the taxonomy definitions stay the model's reference text. */
export function loadLabels(taxonomyPath: string): LabelFile {
  const path = taxonomyPath.replace(/\.json$/, ".labels.json");
  const cached = cache.get(path);
  if (cached) return cached;
  const labels: LabelFile = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as LabelFile : { dimensions: {}, values: {}, computed: {} };
  cache.set(path, labels);
  return labels;
}

const pick = (pair: Pair | undefined, lang: Lang, fallback: string): string => pair ? pair[lang === "zh" ? 0 : 1] : fallback;

export function tagLabel(labels: LabelFile, dimension: string, value: string, lang: Lang): string {
  return `${pick(labels.dimensions[dimension], lang, dimension)}${lang === "zh" ? "：" : ": "}${pick(labels.values[dimension]?.[value], lang, value)}`;
}

export function computedLabel(labels: LabelFile, key: string, value: string | null, lang: Lang): string {
  const entry = labels.computed[key];
  const name = pick(entry?.label, lang, key);
  if (value === null) return name;
  return `${name}${lang === "zh" ? "：" : ": "}${pick(entry?.values?.[value], lang, value)}`;
}

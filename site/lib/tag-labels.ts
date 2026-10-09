import labels from "./taxonomy-labels.json";

import type { Lang } from "./i18n";

// Display-only translations shared with the service (docs/taxonomy/v3.labels.json). Persisted taxonomy keys stay unchanged.
type Pair = [string, string];
const dimensions = labels.dimensions as unknown as Record<string, Pair>;
const values = labels.values as unknown as Record<string, Record<string, Pair>>;
const index = (lang: Lang): 0 | 1 => (lang === "zh" ? 0 : 1);

export function tagDimensionLabel(dimension: string, lang: Lang = "zh"): string {
  return dimensions[dimension]?.[index(lang)] ?? dimension.replaceAll("_", " ");
}

export function tagLabel(value: string | readonly string[], dimension?: string, lang: Lang = "zh"): string {
  if (typeof value !== "string") return value.map((item) => tagLabel(item, dimension, lang)).join(lang === "zh" ? "、" : ", ") || "—";
  const scoped = dimension ? values[dimension]?.[value] : undefined;
  const any = scoped ?? Object.values(values).find((group) => group[value])?.[value];
  return any?.[index(lang)] ?? value.replaceAll("_", " ");
}

export function tagConfidenceLabel(confidence: string, lang: Lang = "zh"): string {
  const table: Record<string, Pair> = { high: ["信心高", "High confidence"], medium: ["信心中", "Medium confidence"], low: ["信心低", "Low confidence"] };
  return table[confidence]?.[index(lang)] ?? (lang === "zh" ? "信心未评定" : "Unrated");
}

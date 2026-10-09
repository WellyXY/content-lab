import { readFileSync } from "node:fs";

export interface TaxonomyDimension {
  label: string;
  multi: boolean;
  values: Record<string, string>;
}

export interface Taxonomy {
  version: string;
  dimensions: Record<string, TaxonomyDimension>;
}

export interface TagDecision {
  value: string | string[];
  confidence: "high" | "medium" | "low";
  evidence: number[];
}

export interface AnalysisOutput {
  tags: Record<string, TagDecision>;
  frame_texts: Array<{ frame: number; text: string }>;
  hook_text: string;
  hook_translation_zh: string;
  hook_translation_en: string;
  /** Legacy model field; the stored transcript always comes from Whisper. */
  transcript?: string;
  summary_zh: string;
  summary_en: string;
  script_segments: ScriptSegment[];
  formula_zh: string;
  formula_en: string;
  taxonomy_gaps: string[];
}

export const SCRIPT_ROLES = ["hook", "setup", "development", "turn", "payoff", "cta", "other"] as const;

/** One beat of the timed script: what is seen, written and said in that span. */
export interface ScriptSegment {
  /** Display label such as "0–3.2s" or "圖 2". */
  position: string;
  /** Seconds for videos; the 1-based image number for carousels. */
  start_s: number;
  end_s: number;
  role: (typeof SCRIPT_ROLES)[number];
  frames: number[];
  visual_zh: string;
  visual_en: string;
  on_screen_text: string;
  on_screen_text_zh: string;
  on_screen_text_en: string;
  spoken: string;
  spoken_zh: string;
  spoken_en: string;
}

export interface RankingOutput {
  rank: number;
  total: number;
  rationale_zh: string;
  top_reasons: string[];
  similar_post_ids: string[];
}

export function loadTaxonomy(path: string): Taxonomy {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Taxonomy>;
  if (!value.version || !value.dimensions || typeof value.dimensions !== "object") throw new Error("Invalid taxonomy file");
  return { version: value.version, dimensions: value.dimensions };
}

const closedObject = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

export function analysisJsonSchema(taxonomy: Taxonomy): Record<string, unknown> {
  const dimensions = Object.fromEntries(Object.entries(taxonomy.dimensions).map(([name, definition]) => [
    name,
    closedObject({
      value: definition.multi
        ? { type: "array", items: { type: "string", enum: Object.keys(definition.values) } }
        : { type: "string", enum: Object.keys(definition.values) },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: { type: "array", items: { type: "integer" } },
    }),
  ]));
  return closedObject({
    tags: closedObject(dimensions),
    frame_texts: { type: "array", items: closedObject({ frame: { type: "integer" }, text: { type: "string" } }) },
    hook_text: { type: "string" }, hook_translation_zh: { type: "string" }, hook_translation_en: { type: "string" },
    summary_zh: { type: "string" }, summary_en: { type: "string" },
    script_segments: { type: "array", items: closedObject({
      position: { type: "string" }, start_s: { type: "number" }, end_s: { type: "number" },
      role: { type: "string", enum: [...SCRIPT_ROLES] }, frames: { type: "array", items: { type: "integer" } },
      visual_zh: { type: "string" }, visual_en: { type: "string" },
      on_screen_text: { type: "string" }, on_screen_text_zh: { type: "string" }, on_screen_text_en: { type: "string" },
      spoken: { type: "string" }, spoken_zh: { type: "string" }, spoken_en: { type: "string" },
    }) },
    formula_zh: { type: "string" }, formula_en: { type: "string" }, taxonomy_gaps: { type: "array", items: { type: "string" } },
  });
}

export const rankingJsonSchema: Record<string, unknown> = closedObject({
  rank: { type: "integer" }, total: { type: "integer" }, rationale_zh: { type: "string" },
  top_reasons: { type: "array", items: { type: "string" } },
  similar_post_ids: { type: "array", items: { type: "string" } },
});

export function validateAnalysis(value: unknown, taxonomy: Taxonomy): AnalysisOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex output must be an object");
  const output = value as Partial<AnalysisOutput>;
  if (!output.tags || typeof output.tags !== "object") throw new Error("Codex output is missing tags");
  if (Object.keys(output.tags).some((name) => !Object.hasOwn(taxonomy.dimensions, name))) throw new Error("Codex output contains an unknown taxonomy dimension");
  for (const [dimension, definition] of Object.entries(taxonomy.dimensions)) {
    const decision = output.tags[dimension];
    if (!decision || !["high", "medium", "low"].includes(decision.confidence)) throw new Error(`Invalid decision for ${dimension}`);
    const values = Array.isArray(decision.value) ? decision.value : [decision.value];
    if (definition.multi !== Array.isArray(decision.value)) throw new Error(`Invalid cardinality for ${dimension}`);
    if (values.length === 0 || values.some((item) => !Object.hasOwn(definition.values, item))) throw new Error(`Out-of-taxonomy value for ${dimension}`);
    if (!Array.isArray(decision.evidence) || decision.evidence.some((item) => !Number.isInteger(item) || item < 1)) throw new Error(`Invalid evidence for ${dimension}`);
  }
  for (const field of ["hook_text", "hook_translation_zh", "hook_translation_en", "summary_zh", "summary_en", "formula_zh", "formula_en"] as const) {
    if (typeof output[field] !== "string") throw new Error(`Codex output is missing ${field}`);
  }
  if (!Array.isArray(output.frame_texts) || !Array.isArray(output.script_segments) || !Array.isArray(output.taxonomy_gaps)) throw new Error("Codex output has invalid list fields");
  let previousStart = -Infinity;
  for (const segment of output.script_segments) {
    const text = ["position", "visual_zh", "visual_en", "on_screen_text", "on_screen_text_zh", "on_screen_text_en", "spoken", "spoken_zh", "spoken_en"] as const;
    if (!segment || text.some((field) => typeof segment[field] !== "string")) throw new Error("Script segment is missing text fields");
    if (!Number.isFinite(segment.start_s) || !Number.isFinite(segment.end_s) || segment.end_s < segment.start_s) throw new Error("Script segment has an invalid time span");
    if (segment.start_s < previousStart) throw new Error("Script segments are out of order");
    if (!SCRIPT_ROLES.includes(segment.role) || !Array.isArray(segment.frames)) throw new Error("Script segment has an invalid role or frame list");
    previousStart = segment.start_s;
  }
  return output as AnalysisOutput;
}

export function validateRanking(value: unknown, total: number, allowedPostIds: Set<string>): RankingOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ranking output must be an object");
  const output = value as Partial<RankingOutput>;
  if (!Number.isInteger(output.rank) || (output.rank ?? 0) < 1 || (output.rank ?? 0) > total || output.total !== total) throw new Error("Ranking output has an invalid rank or cohort size");
  if (typeof output.rationale_zh !== "string" || !Array.isArray(output.top_reasons) || output.top_reasons.length < 1 || output.top_reasons.length > 3) throw new Error("Ranking output has invalid rationale");
  if (!Array.isArray(output.similar_post_ids) || output.similar_post_ids.length > 3 || output.similar_post_ids.some((id) => typeof id !== "string" || !allowedPostIds.has(id))) throw new Error("Ranking referenced an unknown post");
  return output as RankingOutput;
}

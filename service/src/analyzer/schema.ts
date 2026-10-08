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
  transcript: string;
  summary_zh: string;
  script_segments: Array<{ segment: string; summary_zh: string }>;
  formula_zh: string;
  taxonomy_gaps: string[];
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
    hook_text: { type: "string" }, hook_translation_zh: { type: "string" }, transcript: { type: "string" }, summary_zh: { type: "string" },
    script_segments: { type: "array", items: closedObject({ segment: { type: "string" }, summary_zh: { type: "string" } }) },
    formula_zh: { type: "string" }, taxonomy_gaps: { type: "array", items: { type: "string" } },
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
  for (const field of ["hook_text", "hook_translation_zh", "transcript", "summary_zh", "formula_zh"] as const) {
    if (typeof output[field] !== "string") throw new Error(`Codex output is missing ${field}`);
  }
  if (!Array.isArray(output.frame_texts) || !Array.isArray(output.script_segments) || !Array.isArray(output.taxonomy_gaps)) throw new Error("Codex output has invalid list fields");
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

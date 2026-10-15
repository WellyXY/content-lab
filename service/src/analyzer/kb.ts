import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/kb/v0_1");
/** The parts of the ops knowledge base that steer every evaluation. */
const PROMPT_FILES = ["01_global_principles.md", "02_creative_mechanisms.md", "03_agent_instructions.md", "04_scoring_rubric.json"];

export interface KnowledgeCase { id: string; market: string; format: string | null; mechanism: string | null; motivation: string | null; reported: string | null }
export interface KnowledgeBase { version: string; text: string; hash: string; cases: (market: string) => KnowledgeCase[] }

type CaseLibrary = {
  vn_cases?: Array<{ case_id: string; market: string; format_or_theme?: string; human_observed_mechanism?: string; motivation_hypothesis?: string; historically_reported_ads_data?: { unique_registrations?: number; aggregate_cpa_usd?: number } | null }>;
  cross_market_reference?: Array<{ market: string; example?: string; human_observation?: string; qualification?: string }>;
};

/** Load the knowledge base from the repo; its hash pins which version produced each evaluation. */
export function loadKnowledgeBase(dir = KB_DIR): KnowledgeBase {
  const text = PROMPT_FILES.map((file) => `### ${file}\n${readFileSync(join(dir, file), "utf8").trim()}`).join("\n\n");
  const libraryText = readFileSync(join(dir, "05_case_library.json"), "utf8");
  const library = JSON.parse(libraryText) as CaseLibrary;
  const all: KnowledgeCase[] = [
    ...(library.vn_cases ?? []).map((item) => ({
      id: item.case_id, market: item.market, format: item.format_or_theme ?? null, mechanism: item.human_observed_mechanism ?? null, motivation: item.motivation_hypothesis ?? null,
      reported: item.historically_reported_ads_data?.unique_registrations ? `reported ${item.historically_reported_ads_data.unique_registrations} registrations at $${item.historically_reported_ads_data.aggregate_cpa_usd} each (unverified)` : null,
    })),
    ...(library.cross_market_reference ?? []).map((item, index) => ({
      id: `${item.market}-REF-${index + 1}`, market: item.market, format: item.example ?? null, mechanism: item.human_observation ?? null, motivation: null, reported: item.qualification ?? null,
    })),
  ];
  return {
    version: "v0_1", text,
    hash: createHash("sha256").update(text).update(libraryText).digest("hex"),
    cases: (market) => all.filter((item) => item.market === market),
  };
}

import { describe, expect, it } from "vitest";

import { recordSnapshot, upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { loadKnowledgeBase } from "../src/analyzer/kb.js";
import { assertBlind, buildEvaluationPrompt, EVAL_BACKFILL_PER_DAY, evaluatePost, referenceCases, scheduleEvaluations, validateEvaluation, type Evaluation } from "../src/analyzer/evaluate.js";
import { buildRecreateBrief } from "../src/recreate/brief.js";

const score = (value: number | null) => ({ score: value, confidence: "medium", evidence: [{ label: "OBSERVED_MEDIA", zh: "第 0 秒出现通知", en: "A notification at 0s" }], caveat_zh: "样本有限", caveat_en: "Limited sample" });
export const sampleEvaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  source_status: "complete", evidence_limitations_zh: "无", evidence_limitations_en: "None",
  observed_beats: [{ at: "0-2s", original: "Đang carry cả team", zh: "正在带飞全队", en: "Carrying the team" }],
  hook: { triggers: ["surprise"], forms: ["pov"], zh: "开场惊讶", en: "Surprise opening" },
  reverse: { present: true, setup_zh: "期待", setup_en: "Expectation", reveal_zh: "朋友跑了", reveal_en: "The friend leaves", position: "middle", links_to_motivation: false },
  payoff_zh: "自嘲", payoff_en: "Self-mockery",
  trend_localization_zh: "越南游戏梗", trend_localization_en: "Vietnamese gaming meme",
  product_integration: { visibility: "brief", narrative_function_zh: "传话", narrative_function_en: "Messenger", motivation_connection_zh: "弱", motivation_connection_en: "Weak" },
  motivation: { desire_zh: "找人一起玩", desire_en: "Someone to play with", why_popup_zh: "可以认识同城玩家", why_popup_en: "Meet local players", first_person_thought_zh: "我也想找个队友", first_person_thought_en: "I want a teammate too", plausibility_zh: "可信", plausibility_en: "Plausible", timing_zh: "结尾才出现", timing_en: "Only at the end", entertainment_gap_zh: "好笑但不一定想下载", entertainment_gap_en: "Funny, not necessarily a reason to download" },
  creative_score: score(7), registration_potential: score(4),
  diagnosis: { strengths: [{ zh: "表情好", en: "Good expressions" }], barriers: [{ zh: "动机弱", en: "Weak motivation" }], exceptions_zh: "无", exceptions_en: "None" },
  recommendations: [{ change_zh: "让 PopUp 成为转折", change_en: "Make PopUp the turn", mechanism_zh: "动机", mechanism_en: "Motivation", hypothesis_zh: "注册潜力上升", hypothesis_en: "Higher registration potential", reference_case_ids: ["VN-003"] }],
  summary_zh: "好看但动机弱", summary_en: "Entertaining but weak motivation",
  ...overrides,
});

describe("knowledge base", () => {
  it("loads the principles, mechanisms, rubric and market cases with a stable hash", () => {
    const kb = loadKnowledgeBase();
    expect(kb.text).toContain("GP-004");
    expect(kb.text).toContain("CM-003");
    expect(kb.text).toContain("registration_potential");
    expect(kb.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loadKnowledgeBase().hash).toBe(kb.hash);
    expect(kb.cases("VN").map((item) => item.id)).toContain("VN-003");
    expect(kb.cases("TR")).toEqual([]);
  });
});

function setup() {
  const db = openDatabase(":memory:");
  const meta = (videoId: string) => ({ videoId, url: `https://www.tiktok.com/@a/video/${videoId}`, authorId: "u", authorHandle: "a", caption: "PopUp #fyp", type: "video" as const, durationS: 12, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: "2026-10-01T00:00:00.000Z" });
  const target = upsertPost(db, { source: "tikwm", metrics: null, metadata: meta("7400000000000000001") }, { market: "VN", projectTag: null, boundBy: null });
  recordSnapshot(db, target, { views: 987_654, likes: 43_210, comments: 1, shares: 1, saves: 1 }, "tikwm", "2026-10-09T00:00:00.000Z");
  db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(JSON.stringify({ status: "active", lifetime: { spend: 1234.56, registrations: 7777, cpr: 0.158, installs: 1, impressions: 1, clicks: 1, cpi: 1, cpm: 1, ctr: 0 } }), target.id);
  db.prepare("INSERT INTO post_features(post_id, version, tags_json, summary_zh, analysis_json, model, taxonomy_version, keyframes_json, created_at) VALUES (?, 1, ?, ?, ?, 'm', 'v3', '[]', 't')")
    .run(target.id, JSON.stringify({ hook_type: { value: "contrast", confidence: "high" } }), "女生打游戏被朋友放鸽子", JSON.stringify({ hook_text: "Đang carry", hook_translation_zh: "正在带飞", formula_zh: "期待→落空", summary_zh: "女生打游戏被朋友放鸽子", script_segments: [{ position: "0-2s", role: "hook", visual_zh: "打游戏", spoken_zh: "" }], computed: { duration_s: 12 } }));
  const peers = [["7400000000000000002", 400, 1000, "便宜组"], ["7400000000000000003", 60, 100, "中等组"], ["7400000000000000004", 20, 50, "花费太少"]] as const;
  for (const [videoId, spend, registrations, summary] of peers) {
    const peer = upsertPost(db, { source: "tikwm", metrics: null, metadata: meta(videoId) }, { market: "VN", projectTag: null, boundBy: null });
    db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(JSON.stringify({ status: "inactive", lifetime: { spend, registrations, cpr: spend / registrations, installs: 1, impressions: 1, clicks: 1, cpi: 1, cpm: 1, ctr: 0 } }), peer.id);
    db.prepare("INSERT INTO post_features(post_id, version, tags_json, summary_zh, analysis_json, model, taxonomy_version, keyframes_json, created_at) VALUES (?, 1, '{}', ?, ?, 'm', 'v3', '[]', 't')").run(peer.id, summary, JSON.stringify({ formula_zh: summary, hook_translation_zh: "", summary_zh: summary }));
  }
  return { db, target };
}

describe("blind evaluation prompt", () => {
  it("contains the knowledge base, the analysis and reference cases, but none of the post's own performance", () => {
    const { db, target } = setup();
    const references = referenceCases(db, "VN", target.id);
    expect(references.map((item) => item.summary)).toEqual(["便宜组", "中等组"]);
    const { prompt, postBlock } = buildEvaluationPrompt(db, target.id, 1, loadKnowledgeBase(), references);
    expect(prompt).toContain("GP-002");
    expect(prompt).toContain("女生打游戏被朋友放鸽子");
    expect(prompt).toContain("VN-003");
    for (const leak of ["987654", "987,654", "43210", "1234.56", "7777", "0.158"]) expect(prompt).not.toContain(leak);
    expect(() => assertBlind(postBlock, db, target.id)).not.toThrow();
    expect(() => assertBlind(`${postBlock}\nviews: 987654`, db, target.id)).toThrow(/blind/);
    db.close();
  });
});

describe("evaluation validation", () => {
  const ids = new Set(["VN-003", "post:abc"]);
  it("accepts a complete evaluation and a null score with a reason", () => {
    expect(validateEvaluation(sampleEvaluation(), ids).registration_potential.score).toBe(4);
    expect(validateEvaluation(sampleEvaluation({ creative_score: score(null) }), ids).creative_score.score).toBeNull();
  });
  it("rejects out-of-range scores, ads data as scoring evidence, too many changes and unknown cases", () => {
    expect(() => validateEvaluation(sampleEvaluation({ creative_score: score(11) }), ids)).toThrow(/0–10/);
    expect(() => validateEvaluation(sampleEvaluation({ registration_potential: { ...score(5), evidence: [{ label: "ADS_DATA", zh: "注册很多", en: "Many registrations" }] } }), ids)).toThrow(/blind/);
    const rec = sampleEvaluation().recommendations[0]!;
    expect(() => validateEvaluation(sampleEvaluation({ recommendations: [rec, rec, rec, rec] }), ids)).toThrow(/at most 3/);
    expect(() => validateEvaluation(sampleEvaluation({ recommendations: [{ ...rec, reference_case_ids: ["VN-999"] }] }), ids)).toThrow(/unknown reference/);
    expect(() => validateEvaluation(sampleEvaluation({ recommendations: [{ ...rec, reference_case_ids: ["VN-003", "post:abc", "VN-003"] }] }), ids)).toThrow(/at most 2/);
  });
});

describe("evaluatePost", () => {
  it("stores frozen scores once per analysis and knowledge-base version and syncs them", async () => {
    const { db, target } = setup();
    let runs = 0;
    const run = async () => { runs += 1; return sampleEvaluation({ recommendations: [] }); };
    const config = { mediaDir: "/tmp/none", claudeModel: "m", analyzerProvider: "claude", siteKbV2: true } as never;
    const first = await evaluatePost(db, config, target.id, 1, { run });
    expect(first?.registration_potential.score).toBe(4);
    await evaluatePost(db, config, target.id, 1, { run });
    expect(runs).toBe(1);
    const row = db.prepare("SELECT id, band, inputs_json FROM predictions WHERE post_id=? AND id LIKE 'eval-%'").get(target.id) as { id: string; band: string; inputs_json: string };
    expect(row.band).toBe("evaluation");
    expect(JSON.parse(row.inputs_json)).toMatchObject({ kind: "kb_evaluation", kbHash: loadKnowledgeBase().hash, creativeScore: 7, registrationPotential: 4 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE type='prediction'").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("evaluation scheduling", () => {
  it("queues every new post, a daily batch of older ones with promoted posts first, and nothing twice", () => {
    const { db, target } = setup();
    const kb = loadKnowledgeBase();
    const now = new Date("2026-10-15T00:00:00.000Z");
    // setup() binds posts now; make the target recent and the rest old.
    db.prepare("UPDATE posts SET bound_at='2026-09-01T00:00:00.000Z'").run();
    db.prepare("UPDATE posts SET bound_at='2026-10-14T00:00:00.000Z' WHERE id=?").run(target.id);
    expect(scheduleEvaluations(db, now, kb)).toEqual({ fresh: 1, backfill: 3 });
    const order = (db.prepare("SELECT json_extract(payload_json,'$.postId') AS id, json_extract(payload_json,'$.backfill') AS backfill FROM jobs WHERE kind='evaluate' ORDER BY rowid").all() as Array<{ id: string; backfill: number }>);
    expect(order[0]).toMatchObject({ id: target.id, backfill: 0 });
    expect(scheduleEvaluations(db, now, kb)).toEqual({ fresh: 0, backfill: 0 });
    expect(EVAL_BACKFILL_PER_DAY).toBe(30);
    db.close();
  });
  it("leaves evaluations off the Site until the Site release that shows them", async () => {
    const { db, target } = setup();
    const config = { mediaDir: "/tmp/none", claudeModel: "m", analyzerProvider: "claude", siteKbV2: false } as never;
    await evaluatePost(db, config, target.id, 1, { run: async () => sampleEvaluation({ recommendations: [] }) });
    expect((db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE type='prediction'").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("recreate brief", () => {
  it("leads with the download motivation and the knowledge base changes", () => {
    const brief = buildRecreateBrief({ postId: "p", market: "VN", durationS: 10, caption: null, transcript: null, script: [], assessment: null, playbookSummary: null, memories: "",
      evaluation: { desire: "找队友", whyPopup: "同城玩家", firstPersonThought: "我也想", gap: "好笑但不想下载", recommendations: ["让 PopUp 成为转折（机制：动机）"], barriers: ["动机太晚"] } });
    expect(brief).toContain("Download motivation");
    expect(brief).toContain("让 PopUp 成为转折");
    expect(brief.indexOf("Download motivation")).toBeLessThan(brief.indexOf("v1 assessment"));
  });
});

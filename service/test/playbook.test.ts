import { describe, expect, it } from "vitest";

import { checkScriptCoverage } from "../src/analyzer/codex.js";
import { chooseFrameTimes, parseShowinfoTimes } from "../src/analyzer/media.js";
import {
  buildEvidence, marketWeekStart, marketsDueForPlaybook, playbookJobKey, playbookOutcome, renderStat, validateAssessment, validatePlaybook,
  type PlaybookDocument, type StoredPlaybook,
} from "../src/analyzer/playbook.js";
import type { AnalysisOutput, Taxonomy } from "../src/analyzer/schema.js";
import { openDatabase } from "../src/db/database.js";
import { computeFeatures } from "../src/domain/features.js";
import { enqueueJob } from "../src/jobs/queue.js";

const taxonomy: Taxonomy = {
  version: "test",
  dimensions: { hook_type: { label: "開場鉤子（前 3 秒）", multi: false, values: { contrast: "對比", weak: "沒有鉤子" } } },
};

describe("timed keyframes", () => {
  it("covers the whole video instead of the first dozen cuts", () => {
    const cuts = Array.from({ length: 40 }, (_, index) => index * 0.5 + 0.5);
    const times = chooseFrameTimes(60, cuts);
    expect(times[0]).toBe(0);
    expect(times.length).toBeLessThanOrEqual(12);
    expect(Math.max(...times)).toBeGreaterThan(40);
  });

  it("fills long stretches without a cut and parses showinfo timestamps", () => {
    const times = chooseFrameTimes(30, []);
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.every((time, index) => index === 0 || time > times[index - 1]!)).toBe(true);
    expect(parseShowinfoTimes("[Parsed_showinfo_1] n:0 pts:0 pts_time:0 \n n:1 pts:1 pts_time:3.42 ")).toEqual([0, 3.42]);
  });
});

describe("computed features", () => {
  it("derives pacing, speech and local publish time without the model", () => {
    const features = computeFeatures({
      type: "video", facts: { durationS: 20, width: 1080, height: 1920, sceneCuts: 6, imageCount: null }, durationS: 20,
      transcript: { text: "bir iki üç dört beş altı", language: "tr", model: "small", segments: [{ startS: 1.5, endS: 4.5, text: "bir iki üç dört beş altı" }] },
      musicTitle: "orijinal ses - creator", caption: "PopUp'ta tanıştık #popup #fyp", publishedAt: "2026-10-01T21:30:00.000Z", market: "TR",
      frameTexts: ["merhaba", ""], brandNames: ["PopUp"],
    });
    expect(features).toMatchObject({
      duration_band: "20-40s", cuts_per_10s: 3, pacing_band: "fast", has_speech: true, speech_words: 6, speech_words_per_min: 120,
      first_speech_s: 1.5, music_type: "original", hashtag_count: 2, brand_in_caption: true, publish_hour_local: 0, publish_weekday_local: 5,
    });
  });
});

describe("timed script coverage", () => {
  const base = { script_segments: [{ position: "0–5s", start_s: 0, end_s: 5, role: "hook", frames: [1], visual_zh: "", on_screen_text: "", on_screen_text_zh: "", spoken: "", spoken_zh: "" }] } as unknown as AnalysisOutput;
  it("rejects a script that drops the transcript or skips carousel images", () => {
    const transcript = { text: "this transcript is definitely long enough", language: "en", model: "small", segments: [] };
    expect(() => checkScriptCoverage(base, transcript, [{ file: "kf-01.jpg", timeS: 0, imageIndex: null }])).toThrow(/dropped/);
    expect(() => checkScriptCoverage(base, null, [{ file: "img-01.jpg", timeS: null, imageIndex: 1 }, { file: "img-02.jpg", timeS: null, imageIndex: 2 }])).toThrow(/2 images/);
    expect(() => checkScriptCoverage(base, null, [{ file: "kf-01.jpg", timeS: 0, imageIndex: null }])).not.toThrow();
  });
});

function seededDatabase() {
  const db = openDatabase(":memory:");
  const now = "2026-10-08T00:00:00.000Z";
  for (let index = 0; index < 12; index += 1) {
    const id = `p${index}`;
    db.prepare("INSERT INTO posts(id,video_id,url,market,type,published_at,bound_at,features_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ready',?,?)")
      .run(id, `74123456789012345${String(index).padStart(2, "0")}`, `https://www.tiktok.com/@a/video/${index}`, "TR", "video", "2026-09-20T00:00:00.000Z", now, now, now);
    const hook = index < 4 ? "contrast" : "weak";
    db.prepare("INSERT INTO post_features(post_id,version,model,taxonomy_version,tags_json,summary_zh,keyframes_json,analysis_json,created_at) VALUES (?,1,'m','test',?,?,'[]',?,?)")
      .run(id, JSON.stringify({ hook_type: { value: hook } }), `摘要 ${index}`, JSON.stringify({ computed: { pacing_band: index < 4 ? "fast" : "slow", duration_s: 10 + index } }), now);
    db.prepare("INSERT INTO metric_snapshots(id,post_id,captured_at,hour_bucket,views,likes,comments,shares,source,ok,created_at) VALUES (?,?,?,?,?,0,0,0,'tikwm',1,?)")
      .run(`s${index}`, id, now, now, (12 - index) * 10_000, now);
  }
  return db;
}

describe("playbook evidence", () => {
  it("separates the top quarter from the bottom half and keeps numbers out of the model's prose", () => {
    const db = seededDatabase();
    const evidence = buildEvidence(db, taxonomy, "TR", "2026-10-08T00:00:00.000Z");
    expect(evidence).toMatchObject({ eligiblePosts: 12, topSize: 3, bottomSize: 6 });
    const contrast = evidence.stats.find((row) => row.key === "tag:hook_type=contrast")!;
    expect(contrast).toMatchObject({ topPosts: 3, bottomPosts: 0, lift: 1 });
    expect(renderStat(contrast, evidence)).toContain("高播放组 3/3");
    expect(renderStat(contrast, evidence, "en")).toContain("top tier 3/3");

    const document: PlaybookDocument = {
      summary_zh: "对比开场最有效。", summary_en: "Contrast openings work best.",
      patterns: [
        { id: "P1", title_zh: "对比开场", title_en: "Contrast opening", description_zh: "第一秒就给出对比。", description_en: "Show the contrast in the first second.", why_it_works_zh: "制造落差。", why_it_works_en: "It creates a gap.", how_to_apply_zh: "先放别人的版本。", how_to_apply_en: "Show the other version first.", stat_keys: ["tag:hook_type=contrast"], example_post_ids: ["p0"] },
        { id: "P2", title_zh: "快节奏", title_en: "Fast pacing", description_zh: "剪辑紧凑。", description_en: "Tight cuts.", why_it_works_zh: "留住注意力。", why_it_works_en: "Holds attention.", how_to_apply_zh: "每两秒换画面。", how_to_apply_en: "Change shots every two seconds.", stat_keys: ["feat:pacing_band=fast"], example_post_ids: ["p1"] },
      ],
      anti_patterns: [{ id: "A1", title_zh: "没有钩子", title_en: "No hook", description_zh: "直接进入内容。", description_en: "Starts without a hook.", stat_keys: ["tag:hook_type=weak"], example_post_ids: ["p11"] }],
      weekly_changes: [{ type: "first_version", pattern_id: "-", change_zh: "首版", change_en: "First version" }], open_questions: [], sample_caveat_zh: "样本小。", sample_caveat_en: "Small sample.",
    };
    expect(validatePlaybook(document, evidence)).toBe(document);
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, description_zh: "平均 120K 播放" }, document.patterns[1]!] }, evidence)).toThrow(/numbers come from stat_keys/);
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, why_it_works_en: "58% of top posts use it" }, document.patterns[1]!] }, evidence)).toThrow(/58%/);
    expect(validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, how_to_apply_zh: "像「10M+ 下载」那样直接秀出商店页数据，3 秒内给出反差" }, document.patterns[1]!] }, evidence).patterns[0]!.id).toBe("P1");
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, stat_keys: ["tag:invented=x"] }, document.patterns[1]!] }, evidence)).toThrow(/unknown statistic/);

    const playbook: StoredPlaybook = { id: "pb", market: "TR", version: 1, weekStart: marketWeekStart("TR", "2026-10-08T00:00:00.000Z"), createdAt: "", model: "m", evidence, document };
    const assessment = {
      potential: "high", potential_reason_zh: "符合 P1。", potential_reason_en: "Matches P1.", matched_patterns: [{ pattern_id: "P1", evidence_zh: "第一秒对比", evidence_en: "Contrast in the first second" }], anti_patterns_hit: [], missing_patterns: [],
      suggestions: [{ priority: 1, change_zh: "加快节奏", change_en: "Tighten the pacing", reason_zh: "P2", reason_en: "P2", pattern_ids: ["P2"] }], similar_post_ids: ["p0", "unknown"],
    };
    expect(validateAssessment(assessment, playbook).similar_post_ids).toEqual(["p0"]);
    expect(() => validateAssessment({ ...assessment, matched_patterns: [{ pattern_id: "P9", evidence_zh: "", evidence_en: "" }] }, playbook)).toThrow(/unknown pattern/);
    db.close();
  });

  it("starts the week on Monday in the market's own time zone", () => {
    expect(marketWeekStart("TR", "2026-10-08T12:00:00.000Z")).toBe("2026-10-04T21:00:00.000Z");
    expect(marketWeekStart("VN", "2026-10-04T18:00:00.000Z")).toBe("2026-10-04T17:00:00.000Z");
  });
});

describe("weekly playbook schedule", () => {
  it("is due for a market with enough analyzed posts, but waits for queued re-analyses", () => {
    const db = seededDatabase();
    expect(marketsDueForPlaybook(db, "2026-10-08T00:00:00.000Z")).toEqual(["TR"]);
    enqueueJob(db, { kind: "analyze", payload: { postId: "p3", version: 2 } });
    expect(marketsDueForPlaybook(db, "2026-10-08T00:00:00.000Z")).toEqual([]);
    db.close();
  });
});

describe("bilingual labels", () => {
  it("keeps the Site's copy identical and covers every taxonomy value in both languages", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../..");
    const docs = readFileSync(resolve(root, "docs/taxonomy/v3.labels.json"), "utf8");
    expect(readFileSync(resolve(root, "site/lib/taxonomy-labels.json"), "utf8")).toBe(docs);
    const labels = JSON.parse(docs) as { dimensions: Record<string, [string, string]>; values: Record<string, Record<string, [string, string]>> };
    const taxonomy = JSON.parse(readFileSync(resolve(root, "docs/taxonomy/v3.json"), "utf8")) as { dimensions: Record<string, { values: Record<string, string> }> };
    for (const [dimension, definition] of Object.entries(taxonomy.dimensions)) {
      expect(labels.dimensions[dimension]?.every(Boolean)).toBe(true);
      for (const value of Object.keys(definition.values)) expect(labels.values[dimension]?.[value]?.every(Boolean), `${dimension}.${value}`).toBe(true);
    }
  });
});

describe("registration playbook", () => {
  function promoted() {
    const db = seededDatabase();
    // Contrast openings bring cheap registrations; p0 has the most views but the costliest registrations, p11 the fewest views but the cheapest.
    for (let index = 0; index < 12; index += 1) {
      const cpr = index === 0 ? 9 : index === 11 ? 0.5 : index < 4 ? 1 + index * 0.1 : 2 + index * 0.1;
      const spend = index === 5 ? 20 : 300;
      db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(JSON.stringify({ lifetime: { spend, registrations: spend / cpr } }), `p${index}`);
    }
    return db;
  }

  it("ranks promoted posts by registration cost, leaves thin evidence out and finds counterexamples", () => {
    const db = promoted();
    expect(playbookOutcome(db, "TR")).toBe("registrations");
    const evidence = buildEvidence(db, taxonomy, "TR", "2026-10-08T00:00:00.000Z", [], "", "registrations");
    expect(evidence).toMatchObject({ outcome: "registrations", eligiblePosts: 11, topSize: 3, bottomSize: 5, insufficientPosts: 1, topMaxCpr: 1.2 });
    expect(evidence.posts.filter((post) => post.tier === "top").map((post) => post.id).sort()).toEqual(["p1", "p11", "p2"]);
    expect(evidence.counterexamples).toEqual(expect.arrayContaining([{ id: "p0", kind: "high_views_low_registrations" }, { id: "p11", kind: "low_views_good_registrations" }]));
    const contrast = evidence.stats.find((row) => row.key === "tag:hook_type=contrast")!;
    expect(renderStat(contrast, evidence)).toContain("低注册成本组");
    expect(renderStat(contrast, evidence)).toMatch(/注册成本中位数 \$\d/);
    db.close();
  });

  it("stays on views until a market has enough promoted posts, and switches mid-week once it does", () => {
    const db = seededDatabase();
    expect(playbookOutcome(db, "TR")).toBe("views");
    const now = "2026-10-08T00:00:00.000Z";
    db.prepare("INSERT INTO playbooks(id, market, version, week_start, created_at, model, evidence_json, document_json) VALUES ('pb','TR',1,?,?,'m','{}','{}')").run(marketWeekStart("TR", now), now);
    expect(marketsDueForPlaybook(db, now)).toEqual([]);
    for (let index = 0; index < 12; index += 1) db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(JSON.stringify({ lifetime: { spend: 100, registrations: 50 } }), `p${index}`);
    expect(marketsDueForPlaybook(db, now)).toEqual(["TR"]);
    // Until the Site release that labels registration statistics, the market stays on views.
    expect(marketsDueForPlaybook(db, now, false)).toEqual([]);
    expect(playbookJobKey(db, "TR", now)).toMatch(/:registrations$/);
    db.close();
  });

  it("keeps costs out of prose and checks the exceptions", () => {
    const db = promoted();
    const evidence = buildEvidence(db, taxonomy, "TR", "2026-10-08T00:00:00.000Z", [], "", "registrations");
    const pattern = { id: "P1", title_zh: "对比开场", title_en: "Contrast opening", description_zh: "第一秒就给出对比。", description_en: "Contrast first.", why_it_works_zh: "让人想要同样的体验。", why_it_works_en: "Viewers want the same.", how_to_apply_zh: "先放别人的版本。", how_to_apply_en: "Show theirs first.", stat_keys: ["tag:hook_type=contrast"], example_post_ids: ["p1"] };
    const document: PlaybookDocument = {
      summary_zh: "对比开场带来便宜的注册。", summary_en: "Contrast openings bring cheap registrations.",
      patterns: [pattern, { ...pattern, id: "P2" }], anti_patterns: [{ id: "A1", title_zh: "没有钩子", title_en: "No hook", description_zh: "直接进入。", description_en: "No hook.", stat_keys: ["tag:hook_type=weak"], example_post_ids: ["p10"] }],
      weekly_changes: [], open_questions: [], sample_caveat_zh: "样本小。", sample_caveat_en: "Small sample.",
      exceptions: [{ kind: "high_views_low_registrations", zh: "播放很高但没人想下载", en: "Watched a lot, few wanted the app", post_ids: ["p0"] }],
    };
    expect(validatePlaybook(document, evidence).exceptions).toHaveLength(1);
    expect(() => validatePlaybook({ ...document, summary_zh: "注册成本 $1.20" }, evidence)).toThrow(/Costs come from stat_keys/);
    expect(() => validatePlaybook({ ...document, exceptions: [{ ...document.exceptions![0]!, post_ids: ["nope"] }] }, evidence)).toThrow(/unknown post/);
    db.close();
  });
});

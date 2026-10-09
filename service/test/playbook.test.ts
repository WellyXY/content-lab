import { describe, expect, it } from "vitest";

import { checkScriptCoverage } from "../src/analyzer/codex.js";
import { chooseFrameTimes, parseShowinfoTimes } from "../src/analyzer/media.js";
import {
  buildEvidence, marketWeekStart, marketsDueForPlaybook, renderStat, validateAssessment, validatePlaybook,
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
    expect(renderStat(contrast, evidence)).toContain("高播放組 3/3");

    const document: PlaybookDocument = {
      summary_zh: "對比開場最有效。",
      patterns: [
        { id: "P1", title_zh: "對比開場", description_zh: "第一秒就給出對比。", why_it_works_zh: "製造落差。", how_to_apply_zh: "先放別人的版本。", stat_keys: ["tag:hook_type=contrast"], example_post_ids: ["p0"] },
        { id: "P2", title_zh: "快節奏", description_zh: "剪輯緊湊。", why_it_works_zh: "留住注意力。", how_to_apply_zh: "每兩秒換畫面。", stat_keys: ["feat:pacing_band=fast"], example_post_ids: ["p1"] },
      ],
      anti_patterns: [{ id: "A1", title_zh: "沒有鉤子", description_zh: "直接進入內容。", stat_keys: ["tag:hook_type=weak"], example_post_ids: ["p11"] }],
      weekly_changes: [{ type: "first_version", pattern_id: "-", change_zh: "首版" }], open_questions_zh: [], sample_caveat_zh: "樣本小。",
    };
    expect(validatePlaybook(document, evidence)).toBe(document);
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, description_zh: "平均 120K 播放" }, document.patterns[1]!] }, evidence)).toThrow(/numbers come from stat_keys/);
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, why_it_works_zh: "高播放組有 58% 用了它" }, document.patterns[1]!] }, evidence)).toThrow(/58%/);
    expect(validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, how_to_apply_zh: "像「10M+ 下載」那樣直接秀出商店頁數據，3 秒內給出反差" }, document.patterns[1]!] }, evidence).patterns[0]!.id).toBe("P1");
    expect(() => validatePlaybook({ ...document, patterns: [{ ...document.patterns[0]!, stat_keys: ["tag:invented=x"] }, document.patterns[1]!] }, evidence)).toThrow(/unknown statistic/);

    const playbook: StoredPlaybook = { id: "pb", market: "TR", version: 1, weekStart: marketWeekStart("TR", "2026-10-08T00:00:00.000Z"), createdAt: "", model: "m", evidence, document };
    const assessment = {
      potential: "high", potential_reason_zh: "符合 P1。", matched_patterns: [{ pattern_id: "P1", evidence_zh: "第一秒對比" }], anti_patterns_hit: [], missing_patterns: [],
      suggestions: [{ priority: 1, change_zh: "加快節奏", reason_zh: "P2", pattern_ids: ["P2"] }], similar_post_ids: ["p0", "unknown"],
    };
    expect(validateAssessment(assessment, playbook).similar_post_ids).toEqual(["p0"]);
    expect(() => validateAssessment({ ...assessment, matched_patterns: [{ pattern_id: "P9", evidence_zh: "" }] }, playbook)).toThrow(/unknown pattern/);
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

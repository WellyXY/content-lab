import { describe, expect, it } from "vitest";

import { TIKTOK_TOOLS, type PlannedCall } from "../src/ads/proxy.js";
import { openDatabase } from "../src/db/database.js";
import { topCreativesByCountry } from "../src/creatives/analyze.js";
import { countriesDueForGuide, generateCreativeGuide, guideEvidence, validateGuide } from "../src/creatives/guide.js";
import { creativeReadModel, creativeSyncDue, runCreativeSync } from "../src/creatives/sync.js";

const ok = (data: unknown) => ({ code: 0, message: "OK", data });
const NOW = new Date("2026-11-18T05:00:00.000Z");

function fakeTikTok() {
  const calls: PlannedCall[] = [];
  const report = (window: number) => {
    // Two regular ads share video v1 (ID and VN); a Spark ad and a non-USD row are ignored.
    const scale = window / 7;
    return [
      { dimensions: { ad_id: "a1", country_code: "ID" }, metrics: { spend: String(100 * scale), impressions: "10000", clicks: "200", app_install: "50", registration: "40", currency: "USD" } },
      { dimensions: { ad_id: "a2", country_code: "ID" }, metrics: { spend: String(50 * scale), impressions: "5000", clicks: "100", app_install: "20", registration: "10", currency: "USD" } },
      { dimensions: { ad_id: "a2", country_code: "VN" }, metrics: { spend: String(30 * scale), impressions: "3000", clicks: "60", app_install: "15", registration: "12", currency: "USD" } },
      { dimensions: { ad_id: "a3", country_code: "ID" }, metrics: { spend: "70", impressions: "1", clicks: "1", app_install: "1", registration: "1", currency: "USD" } },
      { dimensions: { ad_id: "a4", country_code: "ID" }, metrics: { spend: "0", impressions: "1", clicks: "0", app_install: "0", registration: "0", currency: "USD" } },
      { dimensions: { ad_id: "a5", country_code: "ID" }, metrics: { spend: "999", impressions: "1", clicks: "0", app_install: "0", registration: "0", currency: "IDR" } },
    ];
  };
  const call = async (planned: PlannedCall): Promise<unknown> => {
    calls.push(planned);
    if (planned.tool === TIKTOK_TOOLS.report) {
      const input = planned.input as { start_date: string };
      const days = Math.round((Date.parse("2026-11-18") - Date.parse(input.start_date)) / 86_400_000);
      return ok({ list: report(days), page_info: { page: 1, total_page: 1 } });
    }
    const { tool_name } = planned.input as { tool_name: string };
    if (tool_name === "ad_get") return ok({ list: [
      { ad_id: "a1", video_id: "v1", ad_name: "ID-v1", campaign_name: "C1" }, { ad_id: "a2", video_id: "v2", ad_name: "ID-v2", campaign_name: "C1" },
      { ad_id: "a3", tiktok_item_id: "7400000000000000001", ad_name: "spark", campaign_name: "C2" },
    ], page_info: { page: 1, total_page: 1 } });
    return ok({ list: [{ video_id: "v1", file_name: "ID-261113-a.mp4", duration: 12.5, video_cover_url: "https://p16/c1.jpg", preview_url: "https://v16/p1" }, { video_id: "v2", file_name: "ID-261113-b.mp4", duration: 9, video_cover_url: "https://p16/c2.jpg", preview_url: "https://v16/p2" }] });
  };
  return { calls, call };
}

describe("regular ad creatives", () => {
  it("keeps regular video ads with spend, sums them per video, window and country, and never calls a write API", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO ad_accounts(advertiser_id, name, updated_at) VALUES ('adv1', 'A', 't')").run();
    const tiktok = fakeTikTok();
    const result = await runCreativeSync(db, { call: tiktok.call }, NOW);
    expect(result).toMatchObject({ status: "ok", accounts: 1, creatives: 2 });
    expect(tiktok.calls.every((call) => call.tool === TIKTOK_TOOLS.report || ["ad_get", "file_video_ad_info_get"].includes((call.input as { tool_name: string }).tool_name))).toBe(true);
    const model = creativeReadModel(db, "v2")!;
    expect(model).toMatchObject({ fileName: "ID-261113-b.mp4", ads: 1 });
    expect((model.stats as Array<{ window: number; country: string; spend: number }>).filter((item) => item.window === 7)).toEqual([
      expect.objectContaining({ country: "ID", spend: 50, registrations: 10 }), expect.objectContaining({ country: "VN", spend: 30 }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM creative_stats WHERE video_id NOT IN ('v1','v2')").get()).toEqual({ n: 0 });
    // Known ads are not looked up again.
    const again = fakeTikTok();
    await runCreativeSync(db, { call: again.call }, NOW);
    expect(again.calls.filter((call) => (call.input as { tool_name?: string }).tool_name === "ad_get")).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE type='creative'").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("waits and retries when the shared connector app hits its rate limit", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO ad_accounts(advertiser_id, name, updated_at) VALUES ('adv1', 'A', 't')").run();
    const tiktok = fakeTikTok();
    let limited = 2;
    const waits: number[] = [];
    const call = async (planned: PlannedCall) => {
      if (limited > 0) { limited -= 1; throw new Error("TikTok API error 40100: App reaches the QPS limit 50"); }
      return tiktok.call(planned);
    };
    const result = await runCreativeSync(db, { call, sleep: async (ms) => { waits.push(ms); } }, NOW);
    expect(result).toMatchObject({ status: "ok", creatives: 2 });
    expect(waits).toEqual([3_000, 10_000]);
    db.close();
  });

  it("picks each country's top creatives by 30-day spend and writes a guide from analyzed ones only, numbers kept out of prose", async () => {
    const db = openDatabase(":memory:");
    for (const [index, spend] of [500, 400, 300, 200].entries()) {
      db.prepare("INSERT INTO creatives(video_id, advertiser_id, file_name, first_seen_at, updated_at, analysis_json, summary_zh) VALUES (?, 'adv', ?, 't', 't', ?, ?)")
        .run(`v${index}`, `f${index}.mp4`, index < 3 ? JSON.stringify({ hook_translation_zh: "钩子", formula_zh: "公式" }) : null, `摘要${index}`);
      db.prepare("INSERT INTO creative_stats(video_id, window_days, country, spend, impressions, clicks, installs, registrations, refreshed_at) VALUES (?, 30, 'TH', ?, 1000, 20, 10, ?, 't')").run(`v${index}`, spend, 10 + index * 10);
    }
    expect(topCreativesByCountry(db).get("TH")).toEqual(["v0", "v1", "v2", "v3"]);
    // v3 is not analyzed yet: no guide.
    expect(countriesDueForGuide(db, NOW)).toEqual([]);
    db.prepare("UPDATE creatives SET analysis_error='failed' WHERE video_id='v3'").run();
    expect(countriesDueForGuide(db, NOW)).toEqual(["TH"]);
    const evidence = guideEvidence(db, "TH", ["v0", "v1", "v2", "v3"]);
    expect(evidence.creatives.map((item) => item.videoId)).toEqual(["v0", "v1", "v2"]);
    expect(evidence.creatives[0]).toMatchObject({ spend: 500, cpr: 50, spendShare: 500 / 1400 });
    const pattern = { id: "S1", title_zh: "开场", title_en: "Opening", description_zh: "第一秒露脸", description_en: "Face first", why_zh: "想认识", why_en: "Curiosity", how_to_apply_zh: "露脸", how_to_apply_en: "Show a face", example_video_ids: ["v0"] };
    const document = { summary_zh: "总结", summary_en: "Summary", scale_patterns: [pattern, { ...pattern, id: "S2" }], efficiency_patterns: [], cautions: [], sample_caveat_zh: "样本少", sample_caveat_en: "Small sample" };
    expect(() => validateGuide({ ...document, summary_zh: "花费占 35.7%" }, evidence)).toThrow(/number in prose/);
    expect(() => validateGuide({ ...document, scale_patterns: [{ ...pattern, example_video_ids: ["v9"] }, pattern] }, evidence)).toThrow(/unknown creative/);
    const guide = await generateCreativeGuide(db, { claudeModel: "m", analyzerProvider: "claude" } as never, "TH", { run: async () => document }, NOW.toISOString());
    expect(guide?.version).toBe(1);
    expect(countriesDueForGuide(db, NOW)).toEqual([]);
    db.close();
  });

  it("syncs once a day from 12:00 Taipei", () => {
    expect(creativeSyncDue(new Date("2026-11-18T03:59:00Z"))).toBeNull();
    expect(creativeSyncDue(new Date("2026-11-18T04:00:00Z"))).toBe("creative_sync:2026-11-18");
  });
});

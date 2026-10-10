import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { createProxyGuard, extractToolResult, TIKTOK_TOOLS } from "../src/ads/proxy.js";
import { adLinkCalls, accountsCall, dailyCalls, lifetimeCalls, METRICS } from "../src/ads/plan.js";
import { parseAccounts, parseAdLinks, parseReportRows } from "../src/ads/parse.js";
import { postAdsSummary, storeAdLinks, storeDaily, storeLifetime, totals } from "../src/ads/store.js";
import { runAdsSync } from "../src/ads/sync.js";

const ok = (data: unknown) => JSON.stringify({ code: 0, message: "OK", data });

describe("ads call planning", () => {
  it("plans fixed, read-only calls", () => {
    expect(accountsCall()).toEqual({ tool: TIKTOK_TOOLS.accounts, input: {} });
    const [full, deleted] = adLinkCalls("adv1", null, 1);
    expect(full!.tool).toBe(TIKTOK_TOOLS.execute);
    expect(full!.input).toMatchObject({ tool_name: "ad_get", params: { advertiser_id: "adv1", page: 1, page_size: 1000 } });
    expect((deleted!.input as { params: { filtering: unknown } }).params.filtering).toEqual({ primary_status: "STATUS_DELETE" });
    const [incremental] = adLinkCalls("adv1", "2026-10-09T02:30:00.000Z", 2);
    expect((incremental!.input as { params: { filtering: unknown; page: number } }).params).toMatchObject({ page: 2, filtering: { modified_after: "2026-10-08 02:30:00" } });
  });

  it("batches report calls by 100 ads with lifetime and 14-day windows", () => {
    const ids = Array.from({ length: 230 }, (_, index) => `ad${index}`);
    const lifetime = lifetimeCalls("adv1", ids);
    expect(lifetime).toHaveLength(3);
    const input = lifetime[0]!.input as { query_lifetime: boolean; dimensions: string[]; filtering: Array<{ field_name: string; filter_value: string }>; metrics: string[] };
    expect(input).toMatchObject({ query_lifetime: true, dimensions: ["ad_id"] });
    expect(JSON.parse(input.filtering.find((item) => item.field_name === "ad_ids")!.filter_value)).toHaveLength(100);
    expect(input.metrics).toEqual(METRICS);
    const daily = dailyCalls("adv1", ids.slice(0, 5), "2026-10-10");
    expect(daily[0]!.input).toMatchObject({ dimensions: ["ad_id", "stat_time_day"], start_date: "2026-09-27", end_date: "2026-10-10" });
  });
});

describe("ads proxy guard", () => {
  it("allows exactly the planned call and nothing else", async () => {
    const call = lifetimeCalls("adv1", ["a1"])[0]!;
    const guard = createProxyGuard(call);
    expect((await guard(call.tool, structuredClone(call.input))).behavior).toBe("allow");
    expect((await guard(call.tool, { ...call.input, advertiser_id: "other" })).behavior).toBe("deny");
    expect((await guard(TIKTOK_TOOLS.execute, { tool_name: "ad_get", params: {} })).behavior).toBe("deny");
    expect((await guard("mcp__claude_ai_Gmail__send_message", {})).behavior).toBe("deny");
  });

  it("never lets tool_execute reach anything but ad_get", async () => {
    const write = { tool: TIKTOK_TOOLS.execute, input: { tool_name: "ad_status_update", params: { advertiser_id: "adv1" } } };
    expect(() => createProxyGuard(write)).toThrow(/ad_get/);
  });

  it("takes the raw TikTok JSON from the tool result, not the model's reply", () => {
    const raw = ok({ list: [{ advertiser_id: "1", advertiser_name: "A" }] });
    const messages = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: TIKTOK_TOOLS.accounts, input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: raw }] }] } },
      { type: "result", subtype: "success", result: "There are 99 accounts" },
    ];
    expect(extractToolResult(messages, TIKTOK_TOOLS.accounts)).toEqual(JSON.parse(raw));
    expect(() => extractToolResult(messages.slice(2), TIKTOK_TOOLS.accounts)).toThrow(/no tool result/);
  });

  it("reads an oversized result from the file the CLI saved it to, but only under the allowed folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ads-saved-"));
    mkdirSync(join(root, "s1", "tool-results"), { recursive: true });
    const file = join(root, "s1", "tool-results", "mcp-claude_ai_TikTok_for_Business-tool_execute-1.txt");
    writeFileSync(file, ok({ list: [{ ad_id: "a1" }] }));
    const note = (path: string) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: TIKTOK_TOOLS.execute, input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `Error: result (239,638 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text` }] }] } },
    ];
    expect(extractToolResult(note(file), TIKTOK_TOOLS.execute, root)).toEqual(JSON.parse(ok({ list: [{ ad_id: "a1" }] })));
    expect(() => extractToolResult(note("/etc/hosts"), TIKTOK_TOOLS.execute, root)).toThrow(/outside/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("ads parsing", () => {
  it("reads accounts, ad links and report rows, refusing API errors", () => {
    expect(parseAccounts(JSON.parse(ok({ list: [{ advertiser_id: "1", advertiser_name: "A" }] })))).toEqual([{ advertiserId: "1", name: "A" }]);
    const links = parseAdLinks(JSON.parse(ok({ list: [{ ad_id: "a1", ad_name: "VN-1", tiktok_item_id: "7400000000000000001", campaign_name: "c" }, { ad_id: "a2" }], page_info: { page: 1, total_page: 2 } })));
    expect(links.links).toEqual([expect.objectContaining({ adId: "a1", itemId: "7400000000000000001", adName: "VN-1" }), expect.objectContaining({ adId: "a2", itemId: null })]);
    expect(links.morePages).toBe(true);
    const rows = parseReportRows(JSON.parse(ok({ list: [{ dimensions: { ad_id: "a1", stat_time_day: "2026-10-09 00:00:00" }, metrics: { spend: "12.50", impressions: "1000", clicks: "20", app_install: "10", registration: "5", video_play_actions: "800", currency: "USD", timezone: "Asia/Hong_Kong" } }], page_info: { page: 1, total_page: 1 } })));
    expect(rows.rows[0]).toMatchObject({ adId: "a1", date: "2026-10-09", spend: 12.5, impressions: 1000, installs: 10, registrations: 5, currency: "USD" });
    expect(() => parseReportRows({ code: 40001, message: "Access token expired" })).toThrow(/40001/);
  });
});

describe("post ads summary", () => {
  const post = (db: ReturnType<typeof openDatabase>, videoId: string) => upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId, url: `https://www.tiktok.com/@a/video/${videoId}`, authorId: "u", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "VN", projectTag: null, boundBy: null });

  it("sums every ad of the post before dividing, and leaves untouched posts as not delivered", () => {
    const db = openDatabase(":memory:");
    const delivered = post(db, "7400000000000000001");
    const organic = post(db, "7400000000000000002");
    storeAdLinks(db, "adv1", [
      { adId: "a1", itemId: "7400000000000000001", adName: "VN-1", campaignName: "c1", campaignId: "1", adgroupId: "g", createTime: null, modifyTime: null },
      { adId: "a2", itemId: "7400000000000000001", adName: "VN-1b", campaignName: "c2", campaignId: "2", adgroupId: "g", createTime: null, modifyTime: null },
    ], "2026-10-10T00:00:00.000Z");
    storeLifetime(db, [
      { adId: "a1", date: null, spend: 30, impressions: 10_000, clicks: 100, installs: 60, registrations: 40, videoPlays: 0, currency: "USD", timezone: null },
      { adId: "a2", date: null, spend: 10, impressions: 10_000, clicks: 100, installs: 20, registrations: 0, videoPlays: 0, currency: "USD", timezone: null },
    ], "2026-10-10T00:00:00.000Z");
    storeDaily(db, [
      { adId: "a1", date: "2026-10-09", spend: 4, impressions: 1000, clicks: 10, installs: 8, registrations: 5, videoPlays: 0, currency: "USD", timezone: "Asia/Hong_Kong" },
      { adId: "a1", date: "2026-10-01", spend: 2, impressions: 500, clicks: 5, installs: 4, registrations: 2, videoPlays: 0, currency: "USD", timezone: "Asia/Hong_Kong" },
    ], "2026-10-10T00:00:00.000Z");
    const summary = postAdsSummary(db, delivered.id, new Date("2026-10-10T03:00:00.000Z"))!;
    expect(summary.adCount).toBe(2);
    expect(summary.lifetime).toMatchObject({ spend: 40, registrations: 40, installs: 80, cpr: 1, cpi: 0.5, cpm: 2 });
    expect(summary.last7d.spend).toBe(4);
    expect(summary.prev7d.spend).toBe(2);
    expect(summary.status).toBe("active");
    expect(summary.topAds[0]).toMatchObject({ adId: "a1", spend: 30 });
    expect(postAdsSummary(db, organic.id, new Date())).toBeNull();
    expect(totals([]).cpr).toBeNull();
    db.close();
  });
});

describe("ads sync", () => {
  it("links ads to tracked posts, fetches metrics only for those, and records the run", async () => {
    const db = openDatabase(":memory:");
    upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7400000000000000001", url: "https://www.tiktok.com/@a/video/7400000000000000001", authorId: "u", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "VN", projectTag: null, boundBy: null });
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const call = async (planned: { tool: string; input: Record<string, unknown> }) => {
      calls.push(planned);
      if (planned.tool === TIKTOK_TOOLS.accounts) return JSON.parse(ok({ list: [{ advertiser_id: "adv1", advertiser_name: "A" }] }));
      if (planned.tool === TIKTOK_TOOLS.execute) return JSON.parse(ok({ list: [{ ad_id: "a1", tiktok_item_id: "7400000000000000001", ad_name: "VN-1" }, { ad_id: "a9", tiktok_item_id: "7999999999999999999" }], page_info: { page: 1, total_page: 1 } }));
      return JSON.parse(ok({ list: [{ dimensions: { ad_id: "a1", ...(planned.input.query_lifetime ? {} : { stat_time_day: "2026-10-09 00:00:00" }) }, metrics: { spend: "5", impressions: "1000", clicks: "1", app_install: "2", registration: "1", video_play_actions: "1", currency: "USD" } }], page_info: { page: 1, total_page: 1 } }));
    };
    const result = await runAdsSync(db, { call }, new Date("2026-10-10T03:00:00.000Z"));
    expect(result).toMatchObject({ status: "ok", linkedAds: 1, accounts: 1 });
    const reportCalls = calls.filter((item) => item.tool === TIKTOK_TOOLS.report);
    expect(reportCalls.every((item) => JSON.stringify(item.input).includes("a1") && !JSON.stringify(item.input).includes("a9"))).toBe(true);
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE type='post'").all() as Array<{ payload_json: string }>;
    expect(outbox.some((row) => (JSON.parse(row.payload_json) as { ads: { lifetime: { spend: number } } | null }).ads?.lifetime.spend === 5)).toBe(true);
    db.close();
  });

  it("stops at the call budget and resumes the account scan on the next run", async () => {
    const db = openDatabase(":memory:");
    let pages = 0;
    const call = async (planned: { tool: string; input: Record<string, unknown> }) => {
      if (planned.tool === TIKTOK_TOOLS.accounts) return JSON.parse(ok({ list: [{ advertiser_id: "adv1", advertiser_name: "A" }] }));
      pages += 1;
      return JSON.parse(ok({ list: [{ ad_id: `x${pages}` }], page_info: { page: pages, total_page: 99 } }));
    };
    const first = await runAdsSync(db, { call }, new Date("2026-10-10T03:00:00.000Z"), { maxCalls: 3 });
    expect(first.status).toBe("partial");
    const scan = db.prepare("SELECT last_link_scan_at FROM ad_accounts WHERE advertiser_id='adv1'").get() as { last_link_scan_at: string | null };
    expect(scan.last_link_scan_at).toBeNull();
    db.close();
  });
});

import { adsSyncDue } from "../src/ads/schedule.js";

describe("ads schedule", () => {
  it("is due once a day from 10:30 in Taipei", () => {
    expect(adsSyncDue(new Date("2026-10-10T02:29:00Z"))).toBeNull();
    expect(adsSyncDue(new Date("2026-10-10T02:30:00Z"))).toBe("ads_sync:2026-10-10");
    expect(adsSyncDue(new Date("2026-10-10T15:59:00Z"))).toBe("ads_sync:2026-10-10");
    expect(adsSyncDue(new Date("2026-10-10T16:00:00Z"))).toBeNull();
  });
});

describe("ads failures", () => {
  it("shows no numbers for a promoted post whose metrics have not been fetched yet", () => {
    const db = openDatabase(":memory:");
    const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7400000000000000005", url: "https://www.tiktok.com/@a/video/7400000000000000005", authorId: "u", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "VN", projectTag: null, boundBy: null });
    storeAdLinks(db, "adv1", [{ adId: "a5", itemId: "7400000000000000005", adName: "x", campaignName: null, campaignId: null, adgroupId: null, createTime: null, modifyTime: null }], "2026-10-10T00:00:00.000Z");
    expect(postAdsSummary(db, post.id, new Date("2026-10-10T03:00:00.000Z"))).toBeNull();
    db.close();
  });

  it("retries a failed call once before giving up", async () => {
    const db = openDatabase(":memory:");
    let accountAttempts = 0;
    const call = async (planned: { tool: string; input: Record<string, unknown> }) => {
      if (planned.tool === TIKTOK_TOOLS.accounts) {
        accountAttempts += 1;
        if (accountAttempts === 1) throw new Error("no tool result for accounts");
        return JSON.parse(ok({ list: [] }));
      }
      throw new Error("unexpected");
    };
    expect((await runAdsSync(db, { call }, new Date("2026-10-10T03:00:00.000Z"))).status).toBe("ok");
    expect(accountAttempts).toBe(2);
    db.close();
  });
});

import { describe, expect, it, vi } from "vitest";

import { evaluateAlerts } from "../src/domain/alerts.js";
import { deriveHourlyRows } from "../src/domain/hourly.js";
import { cadenceForPost } from "../src/domain/schedule.js";
import { expandTikTokUrl, normalizeTikTokUrl } from "../src/domain/tiktok-url.js";

describe("TikTok URL boundary", () => {
  it("accepts supported TikTok URLs and removes tracking parameters", () => {
    expect(normalizeTikTokUrl("https://www.tiktok.com/@creator/video/7412345678901234567?is_from_webapp=1#x")).toBe(
      "https://www.tiktok.com/@creator/video/7412345678901234567",
    );
    expect(normalizeTikTokUrl("https://vt.tiktok.com/ZSabc123/")).toBe("https://vt.tiktok.com/ZSabc123/");
  });

  it("rejects lookalike hosts and non-HTTP protocols", () => {
    expect(() => normalizeTikTokUrl("https://tiktok.com.evil.test/@x/video/1")).toThrow(/TikTok/);
    expect(() => normalizeTikTokUrl("file:///etc/passwd")).toThrow(/HTTPS/);
    expect(() => normalizeTikTokUrl("https://user:password@www.tiktok.com/@a/video/7412345678901234567")).toThrow(/credentials/);
    expect(() => normalizeTikTokUrl("https://www.tiktok.com:8443/@a/video/7412345678901234567")).toThrow(/port/);
  });

  it("resolves chained short links including tiktok.com/t URLs", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://vm.tiktok.com/ZSabc123/" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://www.tiktok.com/@creator/video/7412345678901234567?tracking=1" } }));
    expect(await expandTikTokUrl("https://www.tiktok.com/t/ZSxyz456/", fetchImpl)).toBe("https://www.tiktok.com/@creator/video/7412345678901234567");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a short-link redirect outside TikTok", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.com/" } }));
    await expect(expandTikTokUrl("https://vt.tiktok.com/ZSabc123/", fetchImpl)).rejects.toThrow(/TikTok/);
  });
});

describe("adaptive capture cadence", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");

  it("uses hourly, three-hour, daily and stopped bands", () => {
    expect(cadenceForPost({ publishedAtMs: now - 2 * 86_400_000, nowMs: now, views: 100, recentThreeHourDelta: 0 })).toMatchObject({ state: "active", intervalMs: 3_600_000 });
    expect(cadenceForPost({ publishedAtMs: now - 5 * 86_400_000, nowMs: now, views: 100, recentThreeHourDelta: 1 })).toMatchObject({ state: "slow", intervalMs: 10_800_000 });
    expect(cadenceForPost({ publishedAtMs: now - 10 * 86_400_000, nowMs: now, views: 100, recentThreeHourDelta: 0 })).toMatchObject({ state: "daily", intervalMs: 86_400_000 });
    expect(cadenceForPost({ publishedAtMs: now - 31 * 86_400_000, nowMs: now, views: 100, recentThreeHourDelta: 0 })).toMatchObject({ state: "stopped", intervalMs: null });
  });

  it("promotes a 3–7 day post when three-hour growth reaches five percent", () => {
    expect(cadenceForPost({ publishedAtMs: now - 5 * 86_400_000, nowMs: now, views: 1_000, recentThreeHourDelta: 50 })).toMatchObject({ state: "active", intervalMs: 3_600_000 });
  });
});

describe("hourly projection", () => {
  it("keeps sleep hours missing and assigns the cross-gap delta to wake-up", () => {
    expect(
      deriveHourlyRows(
        { capturedAt: "2026-10-08T01:10:00.000Z", views: 1_000, likes: 100, comments: 10, shares: 5, saves: 2 },
        { capturedAt: "2026-10-08T05:03:00.000Z", views: 1_600, likes: 130, comments: 16, shares: 8, saves: 5 },
      ),
    ).toEqual([
      { hourBucket: "2026-10-08T02:00:00.000Z", viewsCum: null, viewsDelta: null, likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "missing" },
      { hourBucket: "2026-10-08T03:00:00.000Z", viewsCum: null, viewsDelta: null, likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "missing" },
      { hourBucket: "2026-10-08T04:00:00.000Z", viewsCum: null, viewsDelta: null, likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "missing" },
      { hourBucket: "2026-10-08T05:00:00.000Z", viewsCum: 1_600, viewsDelta: 600, likesDelta: 30, commentsDelta: 6, sharesDelta: 3, savesDelta: 3, coverage: "interpolated" },
    ]);
  });

  it("does not invent a delta without a baseline", () => {
    expect(deriveHourlyRows(null, { capturedAt: "2026-10-08T05:03:00.000Z", views: 12, likes: 2, comments: 1, shares: 0, saves: null })).toEqual([
      { hourBucket: "2026-10-08T05:00:00.000Z", viewsCum: 12, viewsDelta: null, likesDelta: null, commentsDelta: null, sharesDelta: null, savesDelta: null, coverage: "observed" },
    ]);
  });
});

describe("alert rules", () => {
  it("fires every crossed milestone and acceleration from a stable baseline", () => {
    expect(
      evaluateAlerts({ postId: "p1", previousViews: 90_000, currentViews: 520_000, currentDelta: 30_000, priorSixDeltas: [8_000, 9_000, 10_000, 10_000, 11_000, 12_000], day: "2026-10-08" }),
    ).toEqual([
      { rule: "milestone", dedupeKey: "p1:milestone:100000", level: 100_000 },
      { rule: "milestone", dedupeKey: "p1:milestone:500000", level: 500_000 },
      { rule: "acceleration", dedupeKey: "p1:accel:2026-10-08", level: null },
    ]);
  });

  it("does not treat a zero baseline as proof of acceleration", () => {
    expect(evaluateAlerts({ postId: "p1", previousViews: 1, currentViews: 30_001, currentDelta: 30_000, priorSixDeltas: [0, 0], day: "2026-10-08" })).toHaveLength(0);
  });
});

describe("re-ignited and surging posts", () => {
  const now = Date.parse("2026-10-10T05:00:00.000Z");
  it("captures an older post hourly again while its last day grew fast", () => {
    const base = { publishedAtMs: now - 9 * 86_400_000, nowMs: now, views: 777_624, recentThreeHourDelta: 0 };
    expect(cadenceForPost(base)).toMatchObject({ state: "daily" });
    expect(cadenceForPost({ ...base, dayGrowth: { delta: 203_617, base: 574_007 } })).toMatchObject({ state: "active", intervalMs: 3_600_000 });
    expect(cadenceForPost({ ...base, views: 9_000, dayGrowth: { delta: 3_000, base: 6_000 } })).toMatchObject({ state: "active" });
    expect(cadenceForPost({ ...base, dayGrowth: { delta: 10_000, base: 767_624 } })).toMatchObject({ state: "daily" });
  });

  it("raises a daily surge without needing six earlier captures", () => {
    const input = { postId: "p", previousViews: 574_007, currentViews: 777_624, currentDelta: 203_617, priorSixDeltas: [], day: "2026-10-10" };
    expect(evaluateAlerts({ ...input, dayDelta: 203_617, prevDayDelta: null })).toEqual([{ rule: "surge", dedupeKey: "p:surge:2026-10-10", level: null }]);
    expect(evaluateAlerts({ ...input, dayDelta: 30_000, prevDayDelta: 8_000 })).toEqual([expect.objectContaining({ rule: "surge" })]);
    expect(evaluateAlerts({ ...input, dayDelta: 30_000, prevDayDelta: 20_000 })).toEqual([]);
    expect(evaluateAlerts({ ...input, dayDelta: 8_000, prevDayDelta: 1_000 })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { evaluateAlerts } from "../src/domain/alerts.js";
import { deriveHourlyRows } from "../src/domain/hourly.js";
import { cadenceForPost } from "../src/domain/schedule.js";
import { normalizeTikTokUrl } from "../src/domain/tiktok-url.js";

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

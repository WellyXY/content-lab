import { describe, expect, it } from "vitest";

import { bindPosts, deferBinds, drainPendingBinds, pendingBindCounts, remainingDailyQuota } from "../src/bind.js";
import { openDatabase } from "../src/db/database.js";

const link = (id: number) => `https://www.tiktok.com/@k/video/7460000000000${String(id).padStart(6, "0")}`;
const limits = { dailyNewPosts: 5, maxActivePosts: 1_000 };

describe("binds over the daily quota", () => {
  it("are kept in order and bound as the quota frees up, skipping duplicates", () => {
    const db = openDatabase(":memory:");
    const now = new Date("2026-10-14T21:00:00.000Z");
    expect(bindPosts(db, limits, { urls: [link(1), link(2), link(3)], market: "ID", projectTag: null, boundBy: "agent:feishu" }, now).ok).toBe(true);
    expect(remainingDailyQuota(db, limits, now)).toBe(2);
    expect(deferBinds(db, [{ url: link(4), market: "ID" }, { url: link(5), market: "TH" }, { url: link(6), market: "TH" }, { url: link(4), market: "ID" }], "agent:feishu", now)).toBe(3);
    expect(pendingBindCounts(db)).toEqual({ ID: 1, TH: 2 });
    // Two slots left today: the two oldest pending links go in now.
    expect(drainPendingBinds(db, limits, now)).toMatchObject({ queued: 2, remaining: 1 });
    expect(pendingBindCounts(db)).toEqual({ TH: 1 });
    expect(drainPendingBinds(db, limits, new Date("2026-10-15T10:00:00.000Z"))).toMatchObject({ queued: 0, remaining: 1 });
    // A day after the window opened the quota resets and the rest goes in.
    expect(drainPendingBinds(db, limits, new Date("2026-10-15T21:00:01.000Z"))).toMatchObject({ queued: 1, remaining: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='ingest'").get() as { n: number }).n).toBe(6);
    db.close();
  });
});

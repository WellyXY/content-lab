import { describe, expect, it } from "vitest";

import { deletePosts } from "../src/admin/delete-posts.js";
import { ingestPost, recordSnapshot, upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { normalizeTikTokPostUrl } from "../src/domain/tiktok-url.js";
import { enqueueJob } from "../src/jobs/queue.js";
import type { MetricsProvider } from "../src/providers/metrics.js";

const metadata = (videoId: string) => ({ videoId, url: `https://www.tiktok.com/@a/video/${videoId}`, authorId: "u1", authorHandle: "a", caption: "", type: "video" as const, durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null });

describe("post links", () => {
  it("accepts video, photo and short links and refuses profile pages", () => {
    expect(normalizeTikTokPostUrl("https://www.tiktok.com/@a/video/7412345678901234567?lang=en")).toBe("https://www.tiktok.com/@a/video/7412345678901234567");
    expect(normalizeTikTokPostUrl("https://www.tiktok.com/@a/photo/7412345678901234567")).toContain("/photo/");
    expect(normalizeTikTokPostUrl("https://vt.tiktok.com/ZSabc123/")).toContain("vt.tiktok.com");
    expect(() => normalizeTikTokPostUrl("https://www.tiktok.com/@some.creator")).toThrow(/账号主页/);
    expect(() => normalizeTikTokPostUrl("https://www.tiktok.com/tag/dating")).toThrow(/帖子链接/);
  });

  it("never stores a page whose id is not a TikTok post id", async () => {
    const db = openDatabase(":memory:");
    const provider = { fetchPost: async () => ({ source: "tikwm", metrics: null, metadata: metadata("some.creator") }) } as unknown as MetricsProvider;
    await expect(ingestPost(db, provider, { url: "https://www.tiktok.com/@some.creator" })).rejects.toThrow(/Not a TikTok video/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("deleting posts", () => {
  it("removes a post with its derived rows and jobs, drops queued links, and queues Site removals", () => {
    const db = openDatabase(":memory:");
    const keep = upsertPost(db, { source: "tikwm", metrics: null, metadata: metadata("7400000000000000001") }, { market: "VN", projectTag: null, boundBy: null });
    const drop = upsertPost(db, { source: "tikwm", metrics: null, metadata: metadata("7400000000000000002") }, { market: "GCC", projectTag: null, boundBy: null, sitePostId: "site-2" });
    recordSnapshot(db, drop, { views: 10, likes: 1, comments: 0, shares: 0, saves: 0 }, "tikwm");
    recordSnapshot(db, keep, { views: 20, likes: 1, comments: 0, shares: 0, saves: 0 }, "tikwm");
    enqueueJob(db, { kind: "analyze", payload: { postId: drop.id, version: 1 }, idempotencyKey: `analyze:${drop.id}:1` });
    enqueueJob(db, { kind: "ingest", payload: { url: "https://www.tiktok.com/@x", sitePostId: "site-3" }, idempotencyKey: "ingest:x" });
    const deleted = deletePosts(db, { postIds: [drop.id], urls: ["https://www.tiktok.com/@x"] }, null);
    expect(deleted).toEqual([
      { localPostId: drop.id, sitePostId: "site-2", url: drop.url },
      { localPostId: null, sitePostId: "site-3", url: "https://www.tiktok.com/@x" },
    ]);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM posts")).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM metric_snapshots WHERE post_id='${drop.id}'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM metric_snapshots WHERE post_id='${keep.id}'`)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM jobs")).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM sync_outbox WHERE entity_key='${drop.id}' AND type!='post_deleted'`)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sync_outbox WHERE type='post_deleted'")).toBe(2);
    db.close();
  });
});

import { describe, expect, it } from "vitest";

import { recordSnapshot, upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { checkpointTolerance, deriveCheckpoints } from "../src/domain/checkpoints.js";

const published = "2026-10-08T00:00:00.000Z";
const at = (hours: number): string => new Date(Date.parse(published) + hours * 3_600_000).toISOString();
const snapshot = (hours: number, views: number) => ({ capturedAt: at(hours), views, likes: Math.round(views * 0.05), comments: Math.round(views * 0.01), shares: Math.round(views * 0.002), saves: null });

describe("early performance checkpoints", () => {
  it("records the snapshot closest to each age and computes rates only above 1,000 views", () => {
    const checkpoints = deriveCheckpoints(published, [snapshot(0.8, 400), snapshot(1.3, 900), snapshot(3.1, 5_000), snapshot(5.9, 20_000)], Date.parse(at(7)));
    const [one, three, six, day, threeDays] = checkpoints;
    expect(one).toMatchObject({ hours: 1, status: "recorded", ageHours: 0.8, views: 400, viewsPerHour: 500, likeRate: null });
    expect(three).toMatchObject({ status: "recorded", ageHours: 3.1, views: 5_000, likeRate: 0.05, commentRate: 0.01, saveRate: null });
    expect(six).toMatchObject({ status: "recorded", ageHours: 5.9, views: 20_000 });
    expect(day?.status).toBe("pending");
    expect(threeDays?.status).toBe("pending");
  });

  it("marks a checkpoint missed when no capture came near it, and never invents one", () => {
    // Bound four days after publishing: the early checkpoints cannot be recovered.
    const checkpoints = deriveCheckpoints(published, [snapshot(96, 50_000)], Date.parse(at(97)));
    expect(checkpoints.map((item) => item.status)).toEqual(["missed", "missed", "missed", "missed", "recorded"]);
    expect(checkpoints[4]).toMatchObject({ hours: 72, ageHours: 96, views: 50_000 });
    expect(checkpointTolerance(72)).toBe(36);
    expect(deriveCheckpoints(null, [], Date.now()).every((item) => item.status === "missed")).toBe(true);
  });

  it("is refreshed after each capture and carried in the post read model", () => {
    const db = openDatabase(":memory:");
    const metadata = { videoId: "7412345678901234567", url: "https://www.tiktok.com/@a/video/7412345678901234567", authorId: "u1", authorHandle: "a", caption: "", type: "video" as const, durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: published };
    const post = upsertPost(db, { source: "tikwm", metadata, metrics: null }, { market: "TR", projectTag: null, boundBy: null }, at(0.5));
    recordSnapshot(db, post, { views: 2_000, likes: 100, comments: 10, shares: 4, saves: 2 }, "tikwm", at(1.1));
    const stored = JSON.parse((db.prepare("SELECT checkpoints_json FROM posts WHERE id=?").get(post.id) as { checkpoints_json: string }).checkpoints_json) as Array<{ hours: number; status: string; likeRate: number | null }>;
    expect(stored[0]).toMatchObject({ hours: 1, status: "recorded", likeRate: 0.05 });
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE type='post'").get() as { payload_json: string };
    expect((JSON.parse(outbox.payload_json) as { checkpoints: unknown[] }).checkpoints).toHaveLength(5);
    db.close();
  });
});

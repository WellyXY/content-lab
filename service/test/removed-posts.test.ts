import { describe, expect, it, vi } from "vitest";

import { capturePost, recordSnapshot, upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { ProviderError, type MetricsProvider } from "../src/providers/metrics.js";
import { TikTokProvider } from "../src/providers/tiktok.js";

const url = "https://www.tiktok.com/@creator/video/7412345678901234567";

describe("posts that left TikTok", () => {
  it("are recognised when TikWM cannot resolve the link and the embed has no title or author", async () => {
    const empty = { version: "1.0", type: "video", html: "<iframe></iframe>", embed_product_id: "7412345678901234567" };
    for (const embed of [new Response(JSON.stringify(empty), { status: 200 }), new Response(JSON.stringify({ message: "Something went wrong", code: 400 }), { status: 400 })]) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: "Url parsing is failed! Please check url." }), { status: 200 }))
        .mockResolvedValueOnce(embed);
      const error = await new TikTokProvider({ fetchImpl, minIntervalMs: 0, retries: 0 }).fetchPost(url).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).unavailableReason).toBe("likely_removed");
    }
    // An upstream outage is not a removal.
    const outage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: "upstream unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(new TikTokProvider({ fetchImpl: outage, minIntervalMs: 0, retries: 0 }).fetchPost(url)).rejects.toMatchObject({ unavailableReason: "upstream" });
  });

  it("keep being retried for a day, then stop being tracked with the reason recorded", async () => {
    const db = openDatabase(":memory:");
    const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7412345678901234567", url, authorId: "u", authorHandle: "creator", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: "2026-11-06T00:00:00.000Z" } }, { market: "TR", projectTag: null, boundBy: null }, "2026-11-06T01:00:00.000Z");
    recordSnapshot(db, post, { views: 10, likes: 1, comments: 0, shares: 0, saves: 0 }, "tikwm", "2026-11-09T15:00:00.000Z");
    const gone: MetricsProvider = { fetchPost: async () => { throw new ProviderError("Post is no longer publicly available on TikTok (private, under review or deleted)", { retryable: true, unavailableReason: "likely_removed" }); } };
    const state = () => db.prepare("SELECT tracking_state, stop_reason, next_capture_at FROM posts WHERE id=?").get(post.id) as { tracking_state: string; stop_reason: string | null; next_capture_at: string | null };

    await expect(capturePost(db, gone, post.id, "2026-11-10T03:00:00.000Z")).rejects.toThrow(/no longer publicly available/);
    expect(state().tracking_state).not.toBe("stopped");

    await capturePost(db, gone, post.id, "2026-11-10T15:30:00.000Z");
    expect(state()).toMatchObject({ tracking_state: "stopped", next_capture_at: null });
    expect(state().stop_reason).toMatch(/no longer publicly available/);
    db.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisJsonSchema, validateAnalysis, type Taxonomy } from "../src/analyzer/schema.js";
import { postReadModel, upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { TikTokProvider } from "../src/providers/tiktok.js";
import { runSchedulerCycle } from "../src/scheduler.js";
import { flushSyncOutbox, SiteSyncClient } from "../src/sync/client.js";
import { putSyncEvent } from "../src/sync/outbox.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const taxonomy: Taxonomy = {
  version: "test",
  dimensions: {
    format: { label: "Format", multi: false, values: { talking_head: "Talking", other: "Other" } },
    channels: { label: "Channels", multi: true, values: { spoken: "Spoken", visual: "Visual" } },
  },
};

describe("Codex output contract", () => {
  const valid = {
    tags: {
      format: { value: "talking_head", confidence: "high", evidence: [1] },
      channels: { value: ["spoken"], confidence: "medium", evidence: [1] },
    },
    frame_texts: [], hook_text: "hook", hook_translation_zh: "鉤子", transcript: "", summary_zh: "摘要",
    script_segments: [], formula_zh: "公式", taxonomy_gaps: [],
  };

  it("builds a closed schema and accepts only taxonomy values", () => {
    const schema = analysisJsonSchema(taxonomy) as { additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(validateAnalysis(valid, taxonomy).summary_zh).toBe("摘要");
    expect(() => validateAnalysis({ ...valid, tags: { ...valid.tags, format: { ...valid.tags.format, value: "invented" } } }, taxonomy)).toThrow(/Out-of-taxonomy/);
  });
});

describe("TikTok provider contract", () => {
  it("maps a recorded synthetic TikWM response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { id: "7412345678901234567", title: "caption", author: { id: "u1", unique_id: "creator" }, duration: 12, play_count: "1234", digg_count: 120, comment_count: 4, share_count: 8, collect_count: 3, create_time: 1_760_000_000, cover: "https://p16.tiktokcdn.com/a.jpg", play: "https://v16.tiktokcdn.com/a.mp4", music_info: { title: "track" } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new TikTokProvider({ fetchImpl, minIntervalMs: 0, retries: 0 });
    const result = await provider.fetchPost("https://www.tiktok.com/@creator/video/7412345678901234567");
    expect(result).toMatchObject({ source: "tikwm", metadata: { videoId: "7412345678901234567", authorHandle: "creator" }, metrics: { views: 1234, likes: 120 } });
  });

  it("labels oEmbed as metadata-only instead of inventing zero metrics", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: "upstream unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "caption", author_name: "creator", thumbnail_url: "https://p16.tiktokcdn.com/a.jpg" }), { status: 200 }));
    const provider = new TikTokProvider({ fetchImpl, minIntervalMs: 0, retries: 0 });
    const result = await provider.fetchPost("https://www.tiktok.com/@creator/video/7412345678901234567");
    expect(result.source).toBe("tiktok_oembed");
    expect(result.metrics).toBeNull();
    expect(result.fallbackReason).toMatch(/upstream unavailable/);
  });

  it("does not turn an empty oEmbed response into a real post", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: "upstream unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const provider = new TikTokProvider({ fetchImpl, minIntervalMs: 0, retries: 0 });
    await expect(provider.fetchPost("https://www.tiktok.com/@creator/video/7412345678901234567")).rejects.toThrow(/both failed/);
  });

  it("lets TikWM resolve a blocked short link and normalizes relative media paths", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {
        id: "7412345678901234567", author: { unique_id: "creator" }, title: "caption", play_count: 7,
        digg_count: 1, comment_count: 0, share_count: 0, play: "/video/media/real.mp4", cover: "/video/cover/real.jpg",
      } }), { status: 200 }));
    const provider = new TikTokProvider({ fetchImpl, minIntervalMs: 0, retries: 0 });
    const result = await provider.fetchPost("https://vt.tiktok.com/ZSabc123/");
    expect(result.metadata).toMatchObject({ url: "https://www.tiktok.com/@creator/video/7412345678901234567", mediaUrl: "https://www.tikwm.com/video/media/real.mp4", coverUrl: "https://www.tikwm.com/video/cover/real.jpg" });
  });
});

describe("scheduler and outbound sync", () => {
  it("persists the hosted site post id for outbound read-model correlation", () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-site-id-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "test.sqlite"));
    const post = upsertPost(db, {
      source: "tikwm", metrics: null,
      metadata: { videoId: "7412345678901234567", url: "https://www.tiktok.com/@a/video/7412345678901234567", authorId: "a", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, publishedAt: null },
    }, { market: "VN", projectTag: null, boundBy: "site", sitePostId: "site-post-123" }, "2026-10-08T00:00:00.000Z");
    expect(postReadModel(db, post.id)).toMatchObject({ id: "site-post-123", sitePostId: "site-post-123", localPostId: post.id });
    db.close();
  });

  it("detects a sleep gap and queues each overdue post once", () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-contract-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "test.sqlite"));
    db.prepare("INSERT INTO posts(id,video_id,url,bound_at,next_capture_at,created_at,updated_at) VALUES ('p1','7412345678901234567','https://www.tiktok.com/@a/video/7412345678901234567',?,?,?,?)")
      .run("2026-10-08T00:00:00.000Z", "2026-10-08T00:10:00.000Z", "2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
    db.prepare("INSERT INTO scheduler_state(key,value,updated_at) VALUES ('last_scan_at','2026-10-08T00:00:00.000Z','2026-10-08T00:00:00.000Z')").run();
    expect(runSchedulerCycle(db, "2026-10-08T01:00:00.000Z")).toMatchObject({ duePosts: 1, queuedJobs: 1, wokeFromSleep: true });
    expect(runSchedulerCycle(db, "2026-10-08T01:01:00.000Z")).toMatchObject({ duePosts: 1, queuedJobs: 0, wokeFromSleep: false });
    db.close();
  });

  it("deletes only events acknowledged by the GPT Site", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-sync-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "test.sqlite"));
    putSyncEvent(db, "post", "p1", { id: "p1" }, "2026-10-08T00:00:00.000Z");
    const row = db.prepare("SELECT id FROM sync_outbox").get() as { id: string };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ accepted: [row.id] }), { status: 200 }));
    const client = new SiteSyncClient({ baseUrl: "https://site.example", token: "secret", workerId: "test", fetchImpl });
    expect(await flushSyncOutbox(db, client)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count).toBe(0);
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer secret");
    db.close();
  });

  it("retains sitePostId when leasing a hosted bind job", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      jobs: [{ id: "job-1", kind: "bind", payload: { urls: ["https://www.tiktok.com/@a/video/7412345678901234567"], sitePostId: "site-post-123", market: "VN" }, attempts: 1 }],
    }), { status: 200 }));
    const client = new SiteSyncClient({ baseUrl: "https://site.example", token: "secret", workerId: "test", fetchImpl });
    expect(await client.leaseJobs()).toMatchObject([{ id: "job-1", payload: { sitePostId: "site-post-123" } }]);
  });

  it("removes acknowledged duplicate events after a lost response and caps batches to Site limits", async () => {
    const db = openDatabase(":memory:");
    for (let index = 0; index < 60; index += 1) putSyncEvent(db, "job", `job-${index}`, { id: `job-${index}` }, "2026-10-08T00:00:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { events: Array<{ id: string }> };
      expect(request.events).toHaveLength(50);
      return new Response(JSON.stringify({ accepted: [], ignored: request.events.map((event) => event.id) }), { status: 200 });
    });
    const client = new SiteSyncClient({ baseUrl: "https://site.example", token: "secret", workerId: "test", fetchImpl });
    expect(await flushSyncOutbox(db, client, 100)).toBe(50);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get()).toMatchObject({ count: 10 });
    db.close();
  });
});

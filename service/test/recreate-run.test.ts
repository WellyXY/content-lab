import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { upsertPost } from "../src/collector.js";
import { failStaleRecreations, runRecreation } from "../src/recreate/run.js";
import { enqueueJob, leaseJobs } from "../src/jobs/queue.js";
import { SourceUnavailableError } from "../src/recreate/workspace.js";
import { pullRemoteJobs, SiteSyncClient } from "../src/sync/client.js";

const post = (db: ReturnType<typeof openDatabase>) => upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7400000000000000009", url: "https://www.tiktok.com/@a/video/7400000000000000009", authorId: "u", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "VN", projectTag: null, boundBy: null, sitePostId: "site-9" });
const events = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT payload_json FROM sync_outbox WHERE type='recreation' ORDER BY occurred_at").all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as { status: string; counts: number; videoUrl: string | null });

describe("runRecreation", () => {
  it("moves through the stages, uploads, and syncs a complete recreation", async () => {
    const db = openDatabase(":memory:"); post(db);
    const uploads: string[] = []; const notes: string[] = [];
    await runRecreation(db, { mediaDir: "/tmp/unused", claudeModel: "m" } as never, { recreationId: "rc1", sitePostId: "site-9" }, {
      refresh: async () => undefined,
      workspace: async () => ({ dir: "/tmp/ws", sourceDurationS: 10 }),
      agent: async () => ({ notes: { summary_zh: "好", summary_en: "Good", changes: [] }, turns: 5 }),
      render: async () => ({ videoPath: "/tmp/ws/renders/final.mp4", coverPath: "/tmp/ws/renders/cover.jpg", durationS: 9, bytes: 10 }),
      upload: async (_id, filename) => { uploads.push(filename); return `/media/recreations/rc1/${filename}`; },
      notify: async (text) => { notes.push(text); },
    });
    const statuses = events(db);
    expect(statuses.at(-1)).toMatchObject({ status: "complete", videoUrl: "/media/recreations/rc1/video.mp4" });
    expect(uploads).toEqual(["video.mp4", "cover.jpg"]);
    expect(notes[0]).toContain("site-9");
    db.close();
  });

  it("marks an unavailable source as failed without counting it", async () => {
    const db = openDatabase(":memory:"); post(db);
    await expect(runRecreation(db, { mediaDir: "/tmp/unused", claudeModel: "m" } as never, { recreationId: "rc2", sitePostId: "site-9" }, {
      refresh: async () => undefined, upload: async () => "", workspace: async () => { throw new SourceUnavailableError("gone"); },
    })).resolves.toBeUndefined();
    expect(events(db).at(-1)).toMatchObject({ status: "failed", counts: 0 });
    db.close();
  });

  it("lets other errors propagate so the job retries, and marks failure only on the final attempt", async () => {
    const db = openDatabase(":memory:"); post(db);
    const deps = { refresh: async () => undefined, upload: async () => "", workspace: async () => ({ dir: "/tmp/ws", sourceDurationS: 10 }), agent: async () => { throw new Error("agent produced no valid notes.json"); } };
    await expect(runRecreation(db, { mediaDir: "/x", claudeModel: "m" } as never, { recreationId: "rc3", sitePostId: "site-9", finalAttempt: false }, deps)).rejects.toThrow(/notes/);
    expect(events(db).at(-1)?.status).toBe("designing");
    await expect(runRecreation(db, { mediaDir: "/x", claudeModel: "m" } as never, { recreationId: "rc3", sitePostId: "site-9", finalAttempt: true }, deps)).rejects.toThrow(/notes/);
    expect(events(db).at(-1)).toMatchObject({ status: "failed", counts: 1 });
    db.close();
  });
});


describe("recreate jobs from the Site", () => {
  it("queues a local recreate job, completes the Site job at once, and uploads files with PUT", async () => {
    const db = openDatabase(":memory:");
    const calls: Array<{ url: string; method: string; type?: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", type: new Headers(init.headers).get("content-type") });
      if (url.endsWith("/jobs/lease")) return new Response(JSON.stringify({ jobs: [
        { id: "j1", kind: "recreate", payload: { recreationId: "rc9", postId: "site-9" }, attempts: 1 },
        { id: "j2", kind: "recreate", payload: { recreationId: "", postId: "site-9" }, attempts: 1 },
      ] }), { status: 200 });
      if (url.includes("/recreations/")) return new Response(JSON.stringify({ url: "/media/recreations/rc9/video.mp4" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const client = new SiteSyncClient({ baseUrl: "https://site.test", token: "t", workerId: "w", fetchImpl });
    expect(await pullRemoteJobs(db, client)).toBe(1);
    const job = db.prepare("SELECT kind, payload_json, max_attempts FROM jobs").get() as { kind: string; payload_json: string; max_attempts: number };
    expect(job).toMatchObject({ kind: "recreate", max_attempts: 2 });
    expect(JSON.parse(job.payload_json)).toEqual({ recreationId: "rc9", sitePostId: "site-9" });
    expect(calls.some((call) => call.url.endsWith("/jobs/j1/complete"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/jobs/j2/fail"))).toBe(true);
    const file = join(mkdtempSync(join(tmpdir(), "up-")), "video.mp4"); writeFileSync(file, "x");
    expect(await client.uploadRecreationFile("rc9", "video.mp4", file, "video/mp4")).toBe("/media/recreations/rc9/video.mp4");
    expect(calls.at(-1)).toMatchObject({ url: "https://site.test/api/local-worker/recreations/rc9/video.mp4", method: "PUT", type: "video/mp4" });
    db.close();
  });
});

describe("stale recreations", () => {
  it("fails a recreation whose last attempt died with the worker, and leaves live ones alone", async () => {
    const db = openDatabase(":memory:"); post(db);
    await expect(runRecreation(db, { mediaDir: "/x", claudeModel: "m" } as never, { recreationId: "rc4", sitePostId: "site-9" }, {
      refresh: async () => undefined, upload: async () => "", workspace: async () => ({ dir: "/tmp/ws", sourceDurationS: 10 }), agent: async () => { throw new Error("boom"); },
    })).rejects.toThrow();
    enqueueJob(db, { kind: "recreate", payload: { recreationId: "rc4", sitePostId: "site-9" }, idempotencyKey: "r4", maxAttempts: 1 });
    leaseJobs(db, { workerId: "w", limit: 1, leaseMs: 1_000, kinds: ["recreate"] });
    expect(failStaleRecreations(db, new Date(Date.now() + 500))).toBe(0);
    expect(failStaleRecreations(db, new Date(Date.now() + 5_000))).toBe(1);
    expect(events(db).at(-1)).toMatchObject({ status: "failed", counts: 1 });
    expect((db.prepare("SELECT status FROM jobs WHERE idempotency_key='r4'").get() as { status: string }).status).toBe("dead");
    db.close();
  });
});

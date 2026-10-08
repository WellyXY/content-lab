import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db/database.js";
import { enqueueJob, leaseJobs } from "../src/jobs/queue.js";

const dirs: string[] = [];
function testDb() {
  const dir = mkdtempSync(join(tmpdir(), "content-lab-test-"));
  dirs.push(dir);
  return openDatabase(join(dir, "test.sqlite"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable job queue", () => {
  it("leases a due job once and recovers it after lease expiry", () => {
    const db = testDb();
    enqueueJob(db, { kind: "capture", payload: { postId: "p1" }, runAt: "2026-10-08T00:00:00.000Z", idempotencyKey: "capture:p1:0" });
    expect(leaseJobs(db, { now: "2026-10-08T00:00:01.000Z", workerId: "a", limit: 5, leaseMs: 60_000 })).toHaveLength(1);
    expect(leaseJobs(db, { now: "2026-10-08T00:00:02.000Z", workerId: "b", limit: 5, leaseMs: 60_000 })).toHaveLength(0);
    expect(leaseJobs(db, { now: "2026-10-08T00:01:02.000Z", workerId: "b", limit: 5, leaseMs: 60_000 })).toHaveLength(1);
    db.close();
  });
});

describe("public HTTP boundary", () => {
  it("rejects non-TikTok binds and accepts a deduplicated batch as jobs", async () => {
    const db = testDb();
    const app = createApp({ db, config: { bindHourlyPerIp: 30, dailyNewPosts: 300, maxActivePosts: 1_000, bindSecret: null, turnstileSecret: null } });

    const bad = await app.request("/api/posts/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls: ["https://example.com/video/1"] }) });
    expect(bad.status).toBe(400);

    const good = await app.request("/api/posts/bind", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ urls: ["https://www.tiktok.com/@a/video/7412345678901234567", "https://www.tiktok.com/@a/video/7412345678901234567?x=1"], market: "VN" }) });
    expect(good.status).toBe(202);
    const body = await good.json() as { accepted: number; jobs: unknown[] };
    expect(body.accepted).toBe(1);
    expect(body.jobs).toHaveLength(1);
    db.close();
  });

  it("enforces the per-IP hourly bind budget in URL units", async () => {
    const db = testDb();
    const app = createApp({ db, config: { bindHourlyPerIp: 1, dailyNewPosts: 300, maxActivePosts: 1_000, bindSecret: null, turnstileSecret: null } });
    const request = (id: string) => app.request("/api/posts/bind", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ urls: [`https://www.tiktok.com/@a/video/${id}`] }) });
    expect((await request("7412345678901234567")).status).toBe(202);
    expect((await request("7412345678901234568")).status).toBe(429);
    db.close();
  });
});

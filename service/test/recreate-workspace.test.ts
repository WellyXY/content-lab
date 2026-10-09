import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { prepareRecreateWorkspace, SourceUnavailableError } from "../src/recreate/workspace.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(mediaUrl: string | null) {
  const root = mkdtempSync(join(tmpdir(), "recreate-ws-")); dirs.push(root);
  const mediaDir = join(root, "media"); mkdirSync(mediaDir);
  const db = openDatabase(":memory:");
  const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7400000000000000001", url: "https://www.tiktok.com/@a/video/7400000000000000001", authorId: "u", authorHandle: "a", caption: "hi", type: "video", durationS: 2, musicTitle: null, coverUrl: null, mediaUrl, imageUrls: [], publishedAt: null } }, { market: "VN", projectTag: null, boundBy: null });
  return { db, post, config: { mediaDir, dbPath: ":memory:" } as never, root };
}

describe("recreate workspace", () => {
  it("copies the cached source, brand kit and brief", async () => {
    const { db, post, config } = setup(null);
    const postDir = join((config as { mediaDir: string }).mediaDir, post.id); mkdirSync(postDir, { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-pix_fmt", "yuv420p", join(postDir, "source.mp4")]);
    const workspace = await prepareRecreateWorkspace(db, config, { recreationId: "r1", postId: post.id }, { refresh: async () => undefined, init: async () => undefined });
    expect(existsSync(join(workspace.dir, "assets/source.mp4"))).toBe(true);
    expect(existsSync(join(workspace.dir, "brand/brand.json"))).toBe(true);
    expect(readFileSync(join(workspace.dir, "brief.md"), "utf8")).toContain("Market: VN");
    expect(workspace.sourceDurationS).toBeGreaterThan(1.5);
    db.close();
  });

  it("refreshes metadata once and then reports the source as unavailable", async () => {
    const { db, post, config } = setup(null);
    let refreshed = 0;
    await expect(prepareRecreateWorkspace(db, config, { recreationId: "r2", postId: post.id }, { refresh: async () => { refreshed += 1; }, init: async () => undefined }))
      .rejects.toBeInstanceOf(SourceUnavailableError);
    expect(refreshed).toBe(1);
    db.close();
  });
});

describe("recreate workspace safety", () => {
  it("refuses recreation ids that are not a plain token", async () => {
    const { db, post, config } = setup(null);
    for (const recreationId of ["../../..", "a/b", "", "x".repeat(101)]) {
      await expect(prepareRecreateWorkspace(db, config, { recreationId, postId: post.id }, { refresh: async () => undefined, init: async () => undefined }), recreationId).rejects.toThrow(/recreation id/i);
    }
    db.close();
  });

  it("treats a failing metadata refresh (deleted or private post) as an unavailable source", async () => {
    const { db, post, config } = setup(null);
    await expect(prepareRecreateWorkspace(db, config, { recreationId: "r5", postId: post.id }, { refresh: async () => { throw new Error("tikwm: video not found"); }, init: async () => undefined }))
      .rejects.toBeInstanceOf(SourceUnavailableError);
    db.close();
  });

  it("removes the scaffold's agent instructions so only the recreate prompt applies", async () => {
    const { db, post, config } = setup(null);
    const postDir = join((config as { mediaDir: string }).mediaDir, post.id); mkdirSync(postDir, { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-pix_fmt", "yuv420p", join(postDir, "source.mp4")]);
    const workspace = await prepareRecreateWorkspace(db, config, { recreationId: "r6", postId: post.id }, {
      refresh: async () => undefined,
      init: async (dir) => { writeFileSync(join(dir, "CLAUDE.md"), "use npx hyperframes publish"); writeFileSync(join(dir, "AGENTS.md"), "x"); },
    });
    expect(existsSync(join(workspace.dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workspace.dir, "AGENTS.md"))).toBe(false);
    db.close();
  });
});

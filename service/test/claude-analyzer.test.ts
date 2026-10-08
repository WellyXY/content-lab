import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyzerAuthError, claudeArguments, claudeInput, parseClaudeOutput } from "../src/analyzer/claude.js";
import { upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { pullRemoteJobs, SiteSyncClient } from "../src/sync/client.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("Claude analyzer boundary", () => {
  it("runs the requested model with no tools, MCP servers or settings", () => {
    const args = claudeArguments("claude-opus-5-5", { type: "object" });
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual({ type: "object" });
  });

  it("sends frames in order as image blocks before the instruction", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-input-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.jpg"), JPEG);
    writeFileSync(join(dir, "b.png"), PNG);
    const message = JSON.parse(claudeInput("classify", [join(dir, "a.jpg"), join(dir, "b.png")])) as {
      type: string; message: { content: Array<{ type: string; text?: string; source?: { media_type: string; data: string } }> };
    };
    expect(message.type).toBe("user");
    expect(message.message.content.map((block) => block.type)).toEqual(["image", "image", "text"]);
    expect(message.message.content[0]?.source).toMatchObject({ media_type: "image/jpeg", data: JPEG.toString("base64") });
    expect(message.message.content[1]?.source?.media_type).toBe("image/png");
    expect(message.message.content[2]?.text).toBe("classify");
  });

  it("rejects files that are not images instead of forwarding them", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-input-"));
    dirs.push(dir);
    writeFileSync(join(dir, "frame.jpg"), "not an image");
    expect(() => claudeInput("classify", [join(dir, "frame.jpg")])).toThrow(/not a JPEG/);
  });

  it("returns only the structured result and surfaces sign-in failures", () => {
    const success = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { format: "skit_pov" } }),
    ].join("\n");
    expect(parseClaudeOutput(success)).toEqual({ format: "skit_pov" });
    const loggedOut = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    expect(() => parseClaudeOutput(loggedOut)).toThrow(AnalyzerAuthError);
    expect(() => parseClaudeOutput("", "boom")).toThrow(/no result event/);
    expect(() => parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false }))).toThrow(/structured output/);
  });
});

describe("hosted job lease", () => {
  const leaseResponse = (jobs: unknown[]) => new Response(JSON.stringify({ jobs }), { status: 200 });

  it("queues bind and analyze jobs and fails unknown kinds without blocking the batch", async () => {
    const db = openDatabase(":memory:");
    upsertPost(db, {
      source: "tikwm", metrics: null,
      metadata: { videoId: "7412345678901234567", url: "https://www.tiktok.com/@a/video/7412345678901234567", authorId: "u1", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, publishedAt: null },
    }, { market: "VN", projectTag: null, boundBy: null, sitePostId: "site-post-1" });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(leaseResponse([
        { id: "bind-1", kind: "bind", payload: { urls: ["https://www.tiktok.com/@a/video/7412345678901234568"] }, attempts: 1 },
        { id: "analyze-1", kind: "analyze", payload: { postId: "site-post-1" }, attempts: 1 },
        { id: "odd-1", kind: "reindex", payload: {}, attempts: 1 },
      ]))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new SiteSyncClient({ baseUrl: "https://site.example", token: "secret", workerId: "test", fetchImpl });

    expect(await pullRemoteJobs(db, client)).toBe(2);
    const kinds = (db.prepare("SELECT kind FROM jobs WHERE sync_remote_id IS NOT NULL ORDER BY kind").all() as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds).toEqual(["remote_analyze", "remote_bind"]);
    const failure = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/jobs/odd-1/fail"));
    expect(JSON.parse(String(failure?.[1]?.body))).toMatchObject({ retryable: false, error: expect.stringContaining("reindex") });
    db.close();
  });

  it("refuses a second hosted re-analysis of the same post within the cooldown", async () => {
    const db = openDatabase(":memory:");
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(leaseResponse([{ id: "analyze-1", kind: "analyze", payload: { postId: "site-post-1" }, attempts: 1 }]))
      .mockResolvedValueOnce(leaseResponse([{ id: "analyze-2", kind: "analyze", payload: { postId: "site-post-1" }, attempts: 1 }]))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new SiteSyncClient({ baseUrl: "https://site.example", token: "secret", workerId: "test", fetchImpl });

    expect(await pullRemoteJobs(db, client)).toBe(1);
    expect(await pullRemoteJobs(db, client)).toBe(0);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/jobs/analyze-2/fail"))).toBe(true);
    db.close();
  });
});

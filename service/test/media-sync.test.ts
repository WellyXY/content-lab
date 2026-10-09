import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzePost, execFileWithoutInput } from "../src/analyzer/codex.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { uploadKeyframes } from "../src/sync/media.js";

const dirs: string[] = [];
const config = { siteSyncUrl: "https://site.example", siteSyncToken: "test-token" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7zsAAAAASUVORK5CYII=", "base64");
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "content-lab-media-test-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public keyframe delivery", () => {
  it("closes child stdin so prompt-based CLI tools can finish reading piped input", async () => {
    const result = await execFileWithoutInput(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('received-eof'));"], { timeout: 2_000 });
    expect(result.stdout).toBe("received-eof");
  });

  it("does not treat a timeout handler exiting with code zero as a successful model result", async () => {
    await expect(execFileWithoutInput(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], { timeout: 150 })).rejects.toThrow(/terminated before completion/);
  });

  it("reports a process killed by the timeout before it handles SIGTERM as terminated, not a generic failure", async () => {
    await expect(execFileWithoutInput(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { timeout: 1 })).rejects.toThrow(/terminated before completion/);
  });

  it("runs image analysis with a separate prompt and EOF through the CLI boundary", async () => {
    const dir = directory();
    const executable = join(dir, "codex");
    // Simulate the documented CLI contract: --image consumes all following non-option
    // arguments, and any piped stdin must reach EOF before execution can start.
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
let prompt = "";
const images = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--") { prompt = args.slice(i + 1).join(" "); break; }
  if (args[i] === "--image") {
    while (args[i + 1] && !args[i + 1].startsWith("-")) images.push(args[++i]);
  } else if (["--sandbox", "--color", "-C", "--output-schema", "--output-last-message", "--model"].includes(args[i])) i++;
  else if (!args[i].startsWith("-")) prompt = args[i];
}
if (!prompt || images.length !== 1 || !fs.existsSync(images[0])) {
  process.stderr.write("Image arguments consumed the prompt or the image is missing"); process.exit(2);
}
const watchdog = setTimeout(() => { process.stderr.write("stdin did not reach EOF"); process.exit(3); }, 1000);
process.stdin.resume();
process.stdin.on("end", () => {
  clearTimeout(watchdog);
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
    tags: { format: { value: "photo", confidence: "high", evidence: [1] } },
    frame_texts: [], hook_text: "", hook_translation_zh: "", hook_translation_en: "", transcript: "", summary_zh: "測試圖片", summary_en: "test image",
    script_segments: [{ position: "圖 1", start_s: 1, end_s: 1, role: "hook", frames: [1], visual_zh: "測試圖片", visual_en: "test image", on_screen_text: "", on_screen_text_zh: "", on_screen_text_en: "", spoken: "", spoken_zh: "", spoken_en: "" }],
    formula_zh: "", formula_en: "", taxonomy_gaps: []
  }));
});
`, { mode: 0o755 });
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    const mediaDir = join(dir, "media");
    mkdirSync(join(mediaDir, "p1"), { recursive: true });
    writeFileSync(join(mediaDir, "p1", "img-01.png"), png);
    writeFileSync(join(mediaDir, "p1", "frames-v2.json"), JSON.stringify({ frames: [{ file: "img-01.png", timeS: null, imageIndex: 1 }], facts: { durationS: null, width: null, height: null, sceneCuts: null, imageCount: 1 } }));
    const taxonomyPath = join(dir, "taxonomy.json");
    writeFileSync(taxonomyPath, JSON.stringify({ version: "test", dimensions: { format: { label: "Format", multi: false, values: { photo: "Photo" } } } }));
    const db = openDatabase(join(dir, "test.sqlite"));
    try {
      db.prepare("INSERT INTO posts(id,video_id,url,type,bound_at,created_at,updated_at) VALUES ('p1','7412345678901234567','https://www.tiktok.com/@a/photo/7412345678901234567','photo',?,?,?)")
        .run("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
      await analyzePost(db, { ...loadConfig(), analyzerProvider: "codex", mediaDir, taxonomyPath, siteSyncUrl: null, siteSyncToken: null }, "p1");
      expect(db.prepare("SELECT features_state FROM posts WHERE id='p1'").get()).toMatchObject({ features_state: "ready" });
      expect(db.prepare("SELECT summary_zh, keyframes_json FROM post_features WHERE post_id='p1'").get()).toMatchObject({ summary_zh: "測試圖片", keyframes_json: '["/media/p1/img-01.png"]' });
    } finally {
      db.close();
    }
  });

  it("uploads actual image bytes with authentication and publishes stable, content-addressed paths", async () => {
    const frame = join(directory(), "frame-01.png");
    writeFileSync(frame, png);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const paths = await uploadKeyframes(config, "site-post-123", [frame], fetchImpl);
    expect(paths).toEqual([expect.stringMatching(/^\/media\/site-post-123\/frame-01-[a-f0-9]{16}\.png$/)]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://site.example/api/local-worker${paths[0]}`);
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.method).toBe("PUT");
    expect(request?.redirect).toBe("error");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer test-token");
    expect(new Headers(request?.headers).get("content-type")).toBe("image/png");
    expect(Buffer.from(request?.body as Uint8Array)).toEqual(png);
    expect(await uploadKeyframes(config, "site-post-123", [frame], fetchImpl)).toEqual(paths);
  });

  it("fails instead of publishing references when a Site rejects an upload, without copying its body into the error", async () => {
    const frame = join(directory(), "frame-01.png");
    writeFileSync(frame, png);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private upstream details", { status: 401 }));
    await expect(uploadKeyframes(config, "p1", [frame], fetchImpl)).rejects.toThrow("Public keyframe upload returned HTTP 401");
  });

  it("rejects a mislabeled image and validates every file before transmitting the batch", async () => {
    const dir = directory();
    const good = join(dir, "frame-01.png");
    const bad = join(dir, "frame-02.jpg");
    writeFileSync(good, png);
    writeFileSync(bad, png);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(uploadKeyframes(config, "p1", [good, bad], fetchImpl)).rejects.toThrow(/matching its extension/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects large files, symlinks, missing credentials, and insecure destinations", async () => {
    const dir = directory();
    const large = join(dir, "large.jpg");
    const linked = join(dir, "linked.jpg");
    writeFileSync(large, Buffer.alloc(5 * 1024 * 1024 + 1));
    symlinkSync(large, linked);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(uploadKeyframes(config, "p1", [large], fetchImpl)).rejects.toThrow(/at most 5 MiB/);
    await expect(uploadKeyframes(config, "p1", [linked], fetchImpl)).rejects.toThrow(/nonempty image/);
    await expect(uploadKeyframes({ ...config, siteSyncToken: null }, "p1", [], fetchImpl)).rejects.toThrow(/requires both/);
    await expect(uploadKeyframes({ ...config, siteSyncUrl: "http://public.example" }, "p1", [], fetchImpl)).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not create a completed visual analysis when there is no actual media", async () => {
    const dir = directory();
    const db = openDatabase(join(dir, "test.sqlite"));
    try {
      db.prepare("INSERT INTO posts(id,video_id,url,bound_at,created_at,updated_at) VALUES ('p1','7412345678901234567','https://www.tiktok.com/@a/video/7412345678901234567',?,?,?)")
        .run("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
      await expect(analyzePost(db, { ...loadConfig(), mediaDir: join(dir, "media") }, "p1")).rejects.toThrow(/no downloadable media/);
      expect((db.prepare("SELECT COUNT(*) AS count FROM post_features").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });
});

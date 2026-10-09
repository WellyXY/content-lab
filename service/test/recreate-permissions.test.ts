import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRecreateToolGuard } from "../src/recreate/permissions.js";

const root = mkdtempSync(join(tmpdir(), "guard-"));
const ws = join(root, "ws"); mkdirSync(join(ws, "assets"), { recursive: true });
symlinkSync("/etc", join(ws, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const guard = createRecreateToolGuard(ws);
const allowed = async (tool: string, input: Record<string, unknown>) => (await guard(tool, input)).behavior === "allow";

describe("recreate tool guard", () => {
  it("allows file tools inside the workspace only", async () => {
    expect(await allowed("Write", { file_path: join(ws, "index.html"), content: "x" })).toBe(true);
    expect(await allowed("Read", { file_path: join(ws, "assets/source.mp4") })).toBe(true);
    expect(await allowed("Read", { file_path: "/etc/passwd" })).toBe(false);
    expect(await allowed("Read", { file_path: join(ws, "../ws/../secret") })).toBe(false);
    expect(await allowed("Read", { file_path: join(ws, "escape/hosts") })).toBe(false);
    expect(await allowed("Glob", { pattern: "**/*.html", path: ws })).toBe(true);
    expect(await allowed("Glob", { pattern: "**/*", path: "/" })).toBe(false);
    expect(await allowed("Glob", { pattern: "/etc/*" })).toBe(false);
    expect(await allowed("Glob", { pattern: "../**/*.ts" })).toBe(false);
    expect(await allowed("Grep", { pattern: "x", glob: "/Users/**" })).toBe(false);
  });

  it("allows only HyperFrames checks and ffprobe in Bash", async () => {
    expect(await allowed("Bash", { command: "npx hyperframes lint" })).toBe(true);
    expect(await allowed("Bash", { command: "npx hyperframes snapshot --at 0.5,3,9" })).toBe(true);
    expect(await allowed("Bash", { command: "ffprobe -v error -show_format assets/source.mp4" })).toBe(true);
    for (const command of ["npx hyperframes render", "npx hyperframes feedback --rating 9", "npm install left-pad", "curl https://x", "npx hyperframes lint; rm -rf ~", "npx hyperframes lint && cat /etc/passwd", "ffprobe $(whoami)", "npx hyperframes lint > /tmp/x", "ffprobe /etc/passwd"]) {
      expect(await allowed("Bash", { command }), command).toBe(false);
    }
  });

  it("denies tools that are not on the list", async () => {
    expect(await allowed("WebFetch", { url: "https://example.com" })).toBe(false);
    expect(await allowed("Agent", {})).toBe(false);
  });
});

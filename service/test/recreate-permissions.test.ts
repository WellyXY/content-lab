import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRecreateToolGuard, RECREATE_TOOLS } from "../src/recreate/permissions.js";

const root = mkdtempSync(join(tmpdir(), "guard-"));
const ws = join(root, "ws"); mkdirSync(join(ws, "assets"), { recursive: true });
symlinkSync("/etc", join(ws, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const guard = createRecreateToolGuard(ws, ["hyperframes", "hyperframes-core"]);
const allowed = async (tool: string, input: Record<string, unknown>) => (await guard(tool, input)).behavior === "allow";

describe("recreate tool guard", () => {
  it("allows file tools inside the workspace only", async () => {
    expect(await allowed("Write", { file_path: join(ws, "index.html"), content: "x" })).toBe(true);
    expect(await allowed("Write", { file_path: "compositions/scene.html", content: "x" })).toBe(true);
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

  it("refuses home-relative and URL-like paths, which the CLI would expand", async () => {
    for (const file_path of ["~", "~/.zshrc", "~root/.ssh/id_rsa", "file:/etc/passwd", "https://example.com/x"]) {
      expect(await allowed("Read", { file_path }), file_path).toBe(false);
      expect(await allowed("Write", { file_path, content: "x" }), file_path).toBe(false);
    }
    expect(await allowed("Glob", { pattern: "*", path: "~" })).toBe(false);
  });

  it("refuses writes to configuration the tools or the session would load", async () => {
    for (const name of [".npmrc", ".claude/settings.json", ".claude/skills/hyperframes/SKILL.md", "CLAUDE.md", "AGENTS.md", "package.json", "hyperframes.json", ".mcp.json", "node_modules/x.js", "assets/.env", "compositions/CLAUDE.md"]) {
      expect(await allowed("Write", { file_path: join(ws, name), content: "x" }), name).toBe(false);
      expect(await allowed("Edit", { file_path: join(ws, name), old_string: "a", new_string: "b" }), name).toBe(false);
    }
    expect(await allowed("Read", { file_path: join(ws, ".claude/skills/hyperframes/SKILL.md") })).toBe(true);
  });

  it("has no shell, and only the provided skills", async () => {
    expect(RECREATE_TOOLS).not.toContain("Bash");
    expect(await allowed("Bash", { command: "npx hyperframes lint" })).toBe(false);
    expect(await allowed("Skill", { skill: "hyperframes" })).toBe(true);
    expect(await allowed("Skill", { skill: "deploy-everything" })).toBe(false);
    expect(await allowed("WebFetch", { url: "https://example.com" })).toBe(false);
    expect(await allowed("Agent", {})).toBe(false);
  });
});

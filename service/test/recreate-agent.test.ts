import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyzerQuotaError } from "../src/analyzer/claude.js";
import { runRecreateAgent } from "../src/recreate/agent.js";

const fakeQuery = (messages: unknown[], onStart?: (options: Record<string, unknown>) => void) =>
  ((args: { options: Record<string, unknown> }) => { onStart?.(args.options); return (async function* () { for (const m of messages) yield m; })(); }) as never;

describe("recreate agent runner", () => {
  it("runs with the guard, project skills only, and returns notes.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    writeFileSync(join(dir, "notes.json"), JSON.stringify({ summary_zh: "加了钩子", summary_en: "Added a hook", changes: [{ zh: "第一秒通知", en: "Notification at 0s", suggestion: null }] }));
    let seen: Record<string, unknown> = {};
    process.env.SITE_SYNC_TOKEN = "secret-token-value";
    const result = await runRecreateAgent(dir, "claude-opus-5-5", { query: fakeQuery([{ type: "result", subtype: "success", result: "done", num_turns: 12 }], (o) => { seen = o; }) });
    delete process.env.SITE_SYNC_TOKEN;
    expect(result.notes.summary_en).toBe("Added a hook");
    expect(seen).toMatchObject({ cwd: dir, model: "claude-opus-5-5", settingSources: ["project"] });
    expect(typeof seen.canUseTool).toBe("function");
    expect(seen.tools).not.toContain("Bash");
    expect(Object.keys(seen.mcpServers as object)).toEqual(["recreate"]);
    expect(seen.allowedTools).toEqual(expect.arrayContaining(["mcp__recreate__hyperframes_check", "mcp__recreate__probe_media"]));
    expect((seen.env as Record<string, string>).SITE_SYNC_TOKEN).toBeUndefined();
    expect((seen.env as Record<string, string>).HOME).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps a usage-limit result to AnalyzerQuotaError and missing notes to an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    await expect(runRecreateAgent(dir, "m", { query: fakeQuery([{ type: "result", subtype: "error_during_execution", errors: ["Claude AI usage limit reached"] }]) })).rejects.toBeInstanceOf(AnalyzerQuotaError);
    await expect(runRecreateAgent(dir, "m", { query: fakeQuery([{ type: "result", subtype: "success", result: "ok", num_turns: 3 }]) })).rejects.toThrow(/notes\.json/);
    rmSync(dir, { recursive: true, force: true });
  });
});

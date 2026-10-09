import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createRecreateCheckTools } from "../src/recreate/tools.js";

const ws = realpathSync(mkdtempSync(join(tmpdir(), "hf-tools-")));
mkdirSync(join(ws, "assets")); writeFileSync(join(ws, "assets", "source.mp4"), "x");
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function setup() {
  const calls: Array<{ file: string; args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
  const tools = createRecreateCheckTools(ws, {
    exec: async (file, args, options) => { calls.push({ file, args, cwd: options.cwd, env: options.env }); return { stdout: `ok in ${ws}/index.html`, stderr: "" }; },
  });
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await tools.tools.find((item) => item.name === name)!.handler(input as never, {});
    return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
  };
  return { calls, run, names: tools.toolNames };
}

describe("recreate check tools", () => {
  it("run HyperFrames with fixed arguments in the workspace and a minimal environment", async () => {
    const { calls, run, names } = setup();
    process.env.SITE_SYNC_TOKEN = "secret-token-value";
    expect((await run("hyperframes_lint", {})).text).toContain("ok in ./index.html");
    await run("hyperframes_check", {});
    await run("hyperframes_snapshot", { times: [0.5, 3, 9.25] });
    expect(calls.map((call) => call.args)).toEqual([["lint"], ["check"], ["snapshot", "--at", "0.5,3,9.25"]]);
    expect(calls.every((call) => call.cwd === ws && call.env.SITE_SYNC_TOKEN === undefined && call.env.HYPERFRAMES_TELEMETRY === "0")).toBe(true);
    expect(names.every((name) => name.startsWith("mcp__recreate__"))).toBe(true);
    delete process.env.SITE_SYNC_TOKEN;
  });

  it("probes only existing workspace files and refuses everything else", async () => {
    const { calls, run } = setup();
    expect((await run("probe_media", { file: "assets/source.mp4" })).isError).toBe(false);
    expect(calls[0]?.file).toBe("ffprobe");
    expect(calls[0]?.args.at(-1)).toBe(join(ws, "assets", "source.mp4"));
    for (const file of ["~/.ssh/id_ed25519", "../outside.mp4", "/etc/hosts", "https://example.com/a.mp4", "file:/etc/passwd", "assets/missing.mp4", "assets"]) {
      expect((await run("probe_media", { file })).isError, file).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it("refuses snapshot times that are not plain seconds", async () => {
    const { calls, run } = setup();
    for (const times of [[], [-1], [Number.NaN], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]]) {
      expect((await run("hyperframes_snapshot", { times })).isError, JSON.stringify(times)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

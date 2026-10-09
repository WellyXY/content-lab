import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { childEnvironment } from "../analyzer/claude.js";
import { workspaceRelative } from "./permissions.js";
import { HYPERFRAMES_BIN, HYPERFRAMES_ENV } from "./workspace.js";

export const RECREATE_SERVER = "recreate";
const MAX_OUTPUT = 8_000;

type Exec = (file: string, args: string[], options: { cwd: string; env: Record<string, string | undefined>; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const execFileAsync = promisify(execFile);
const defaultExec: Exec = async (file, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { ...options, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    // Lint and check exit non-zero when they find problems; the agent needs that output, not a crash.
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr || failed.message || "command failed" };
  }
};

/** The environment for anything the recreate session starts: no worker secrets. */
export function recreateEnvironment(): Record<string, string | undefined> {
  return { ...childEnvironment(), ...HYPERFRAMES_ENV };
}

const timesSchema = z.array(z.number().finite().min(0).max(600)).min(1).max(12);
const fileSchema = z.string().min(1).max(300);

/**
 * The only commands the recreate agent can run: HyperFrames checks and ffprobe on a workspace file,
 * each with fixed arguments and no shell, so nothing the agent writes can be expanded or chained.
 */
export function createRecreateCheckTools(workspace: string, deps: { exec?: Exec } = {}) {
  const root = realpathSync(workspace);
  const exec = deps.exec ?? defaultExec;
  const ok = (value: string): Text => ({ content: [{ type: "text", text: value }] });
  const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });
  const run = async (file: string, args: string[], timeout: number): Promise<Text> => {
    const { stdout, stderr } = await exec(file, args, { cwd: root, env: recreateEnvironment(), timeout });
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.replaceAll(root, ".").trim();
    return ok(output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…(truncated)` : output || "(no output)");
  };

  const tools = [
    tool("hyperframes_lint", "Run `hyperframes lint` on this project.", {}, async () => run(HYPERFRAMES_BIN, ["lint"], 120_000)),
    tool("hyperframes_check", "Run `hyperframes check` (lint plus a browser pass); the final gate before you finish.", {}, async () => run(HYPERFRAMES_BIN, ["check"], 300_000)),
    tool("hyperframes_snapshot", "Render still frames at the given seconds into snapshots/ (also a contact sheet). Read the images afterwards to review them.", { times: timesSchema }, async (input) => {
      const parsed = timesSchema.safeParse(input.times);
      if (!parsed.success) return fail("times must be 1–12 numbers of seconds between 0 and 600.");
      return run(HYPERFRAMES_BIN, ["snapshot", "--at", parsed.data.join(",")], 300_000);
    }),
    tool("probe_media", "ffprobe a media file inside the workspace (path relative to the project), e.g. assets/source.mp4.", { file: fileSchema }, async (input) => {
      const parsed = fileSchema.safeParse(input.file);
      const relative = parsed.success ? workspaceRelative(root, parsed.data) : null;
      if (relative === null || relative === "") return fail("Give the path of a media file inside the workspace.");
      const absolute = join(root, relative);
      try { if (!statSync(absolute).isFile()) return fail("Not a file."); } catch { return fail("File not found."); }
      return run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", absolute], 60_000);
    }),
  ];
  const server = createSdkMcpServer({ name: RECREATE_SERVER, version: "1.0.0", tools });
  return { server, tools, toolNames: tools.map((item) => `mcp__${RECREATE_SERVER}__${item.name}`) };
}

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The local CLI could not authenticate; the owner must sign in again on the Mac. */
export class AnalyzerAuthError extends Error {
  constructor(message: string) { super(message); this.name = "AnalyzerAuthError"; }
}

/** The subscription's usage window is exhausted; the job should wait, not fail. */
export class AnalyzerQuotaError extends Error {
  constructor(message: string) { super(message); this.name = "AnalyzerQuotaError"; }
}

const QUOTA_EXHAUSTED = /usage limit|limit reached|rate.?limit|resets? (?:at|in)|overloaded|\b429\b|\b529\b/i;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const AUTH_FAILURE = /not logged in|login required|please run \/login|invalid api key|authentication|unauthorized|oauth token|401/i;

/**
 * Claude runs with no tools at all: frames travel inside the message as image
 * blocks, so post content can neither read local files nor reach the network.
 */
export function claudeArguments(model: string, schema: Record<string, unknown>): string[] {
  return [
    "-p", "--model", model,
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--no-session-persistence", "--json-schema", JSON.stringify(schema),
  ];
}

export function imageMediaType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Keyframe is not a JPEG, PNG or WebP image");
}

/** One stream-json user message: every frame in order, then the instruction text. */
export function claudeInput(prompt: string, images: string[]): string {
  const content: unknown[] = images.map((file) => {
    const bytes = readFileSync(file);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Keyframe exceeds the 5 MiB model limit: ${file}`);
    return { type: "image", source: { type: "base64", media_type: imageMediaType(bytes), data: bytes.toString("base64") } };
  });
  content.push({ type: "text", text: prompt });
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** Extract the structured result from Claude's stream-json output. */
export function parseClaudeOutput(stdout: string, stderr = ""): unknown {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") result = event;
    } catch {
      // Non-JSON lines are diagnostics; the result event is authoritative.
    }
  }
  const detail = `${result ? JSON.stringify(result).slice(0, 1_500) : ""}\n${stderr.slice(-1_500)}`.trim();
  if (!result) {
    if (AUTH_FAILURE.test(detail)) throw new AnalyzerAuthError(detail);
    if (QUOTA_EXHAUSTED.test(detail)) throw new AnalyzerQuotaError(detail);
    throw new Error(`claude returned no result event: ${detail || "empty output"}`);
  }
  if (result.is_error === true || result.subtype !== "success") {
    if (AUTH_FAILURE.test(detail)) throw new AnalyzerAuthError(detail);
    if (QUOTA_EXHAUSTED.test(detail)) throw new AnalyzerQuotaError(detail);
    throw new Error(`claude analysis failed: ${detail}`);
  }
  if (result.structured_output === undefined || result.structured_output === null) throw new Error("claude did not return structured output");
  return result.structured_output;
}

/** Only what the CLI needs to find its own sign-in; worker secrets stay out of the child. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "CLAUDE_CONFIG_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export async function runClaude(
  options: { model: string; binary?: string; timeoutMs?: number },
  prompt: string,
  schema: Record<string, unknown>,
  images: string[] = [],
): Promise<unknown> {
  const input = claudeInput(prompt, images);
  // An empty working directory keeps any project CLAUDE.md out of the request.
  const cwd = mkdtempSync(join(tmpdir(), "content-lab-claude-"));
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(options.binary ?? "claude", claudeArguments(options.model, schema), { cwd, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 5 * 60_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = (err + chunk).slice(-16_000); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ code: exitCode, stdout: out, stderr: signal ? `${err}\nterminated by ${signal} (timeout)` : err });
      });
      child.stdin.end(input);
    });
    const output = parseClaudeOutput(stdout, stderr);
    if (code !== 0) throw new Error(`claude exited with ${code}: ${stderr.slice(-1_000)}`);
    return output;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ServiceConfig } from "../config.js";
import { AnalyzerAuthError, runClaude } from "./claude.js";

const execFileAsync = promisify(execFile);

/** Codex appends piped stdin to its prompt and waits until that pipe reaches EOF. */
export async function execFileWithoutInput(file: string, args: string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const pending = execFileAsync(file, args, { ...options, encoding: "utf8" });
  pending.child.stdin?.end();
  const result = await pending;
  if (pending.child.killed) {
    throw Object.assign(new Error("Process was terminated before completion (timeout or output limit)"), result);
  }
  return result;
}

function diagnosticText(value: string): string {
  let redacted = value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
  for (const [key, secret] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|API_KEY|WEBHOOK/i.test(key) && secret && secret.length >= 8) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted.length > 8_000 ? `${redacted.slice(0, 4_000)}\n[…truncated…]\n${redacted.slice(-4_000)}` : redacted;
}

/** Kept under its original name for callers; it covers every analyzer provider. */
export const CodexAuthError = AnalyzerAuthError;

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly capacity: number) {}
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; this.waiting.shift()?.(); }
  }
}

const semaphores = new Map<number, Semaphore>();
const semaphore = (capacity: number): Semaphore => {
  const existing = semaphores.get(capacity);
  if (existing) return existing;
  const created = new Semaphore(capacity);
  semaphores.set(capacity, created);
  return created;
};

export function analyzerModelLabel(config: Pick<ServiceConfig, "analyzerProvider" | "claudeModel" | "codexModel">): string {
  return config.analyzerProvider === "claude" ? config.claudeModel : config.codexModel ?? "codex-default";
}

export async function runModel(
  config: ServiceConfig,
  workDir: string,
  prompt: string,
  schema: Record<string, unknown>,
  images: string[] = [],
): Promise<unknown> {
  if (config.analyzerProvider === "claude") {
    return semaphore(config.analyzerConcurrency).use(() => runClaude({ model: config.claudeModel }, prompt, schema, images));
  }
  return runCodex(config, workDir, prompt, schema, images);
}

async function runCodex(
  config: ServiceConfig,
  workDir: string,
  prompt: string,
  schema: Record<string, unknown>,
  images: string[] = [],
): Promise<unknown> {
  return semaphore(config.codexConcurrency).use(async () => {
    const temp = mkdtempSync(join(tmpdir(), "content-lab-codex-"));
    const schemaPath = join(temp, "schema.json");
    const outputPath = join(temp, "output.json");
    writeFileSync(schemaPath, JSON.stringify(schema));
    try {
      const args = [
        "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--skip-git-repo-check", "--color", "never", "-C", workDir,
        "--output-schema", schemaPath, "--output-last-message", outputPath,
        "-c", 'web_search="disabled"',
      ];
      // A read-only sandbox can still read local files; post content must not reach any tool.
      for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "computer_use", "browser_use", "image_generation", "view_image"]) {
        args.push("--disable", feature);
      }
      if (config.codexModel) args.push("--model", config.codexModel);
      for (const image of images) args.push("--image", image);
      // --image is variadic; terminate option parsing so it cannot consume the prompt.
      args.push("--", prompt);
      let diagnostic = "";
      try {
        const result = await execFileWithoutInput("codex", args, { timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
        diagnostic = diagnosticText(`stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
        writeFileSync(join(workDir, "codex-last-run.log"), diagnostic, { mode: 0o600 });
      } catch (error) {
        const detail = diagnosticText(error && typeof error === "object"
          ? `${"stderr" in error ? String(error.stderr) : ""}\n${"stdout" in error ? String(error.stdout) : ""}`.trim() || (error instanceof Error ? error.message.split("\n")[0] ?? "Process failed" : "Process failed")
          : String(error));
        writeFileSync(join(workDir, "codex-last-run.log"), detail, { mode: 0o600 });
        if (/not logged in|login required|authentication|unauthorized|401/i.test(detail)) throw new AnalyzerAuthError(detail.slice(0, 2_000));
        throw new Error(`codex exec failed: ${detail.slice(0, 2_000)}`, { cause: error });
      }
      if (!existsSync(outputPath)) throw new Error(`codex exec did not write structured output: ${diagnostic.slice(0, 1_000)}\n${diagnostic.slice(-1_000)}`);
      try { return JSON.parse(readFileSync(outputPath, "utf8")); } catch (error) { throw new Error("codex exec returned invalid JSON", { cause: error }); }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { AnalyzerQuotaError } from "../analyzer/claude.js";
import { RECREATE_SYSTEM_PROMPT, recreateTaskPrompt } from "./brief.js";
import { createRecreateToolGuard, RECREATE_TOOLS } from "./permissions.js";
import { createRecreateCheckTools, recreateEnvironment } from "./tools.js";
import { RECREATE_SKILLS } from "./workspace.js";

/** Only defined values, as the SDK expects. */
const defined = (env: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

const QUOTA = /usage limit|limit reached|rate.?limit|resets? (?:at|in)|overloaded|\b429\b|\b529\b/i;
export interface RecreateNotes { summary_zh: string; summary_en: string; changes: Array<{ zh: string; en: string; suggestion: string | null }>; skipped?: Array<{ zh: string; en: string; suggestion: string | null }> }

export async function runRecreateAgent(dir: string, model: string, deps: { query?: typeof query; timeoutMs?: number } = {}): Promise<{ notes: RecreateNotes; turns: number }> {
  const run = deps.query ?? query;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30 * 60_000);
  let turns = 0;
  let failure: string | null = null;
  // Checks run through fixed-argument MCP tools; built-in file tools go through the workspace guard.
  const checks = createRecreateCheckTools(dir);
  try {
    for await (const message of run({
      prompt: recreateTaskPrompt(),
      options: {
        model, cwd: dir, systemPrompt: RECREATE_SYSTEM_PROMPT,
        tools: RECREATE_TOOLS, mcpServers: { recreate: checks.server }, allowedTools: checks.toolNames,
        canUseTool: createRecreateToolGuard(dir, RECREATE_SKILLS), permissionMode: "default",
        settingSources: ["project"], maxTurns: 120, abortController: controller,
        pathToClaudeCodeExecutable: "claude",
        env: defined(recreateEnvironment()),
      },
    }) as AsyncIterable<{ type: string; subtype?: string; num_turns?: number; errors?: string[]; result?: string }>) {
      if (message.type === "result") {
        turns = message.num_turns ?? 0;
        if (message.subtype !== "success") failure = [message.subtype, ...(message.errors ?? [])].join(": ");
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  if (failure && QUOTA.test(failure)) throw new AnalyzerQuotaError(failure);
  const notesFile = join(dir, "notes.json");
  if (!existsSync(notesFile)) throw new Error(`agent produced no valid notes.json${failure ? ` (${failure})` : ""}`);
  const notes = JSON.parse(readFileSync(notesFile, "utf8")) as RecreateNotes;
  if (typeof notes.summary_zh !== "string" || typeof notes.summary_en !== "string" || !Array.isArray(notes.changes)) throw new Error("agent produced no valid notes.json");
  return { notes, turns };
}

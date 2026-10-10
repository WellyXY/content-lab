import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { childEnvironment } from "../analyzer/claude.js";

/** The claude.ai TikTok for Business connector, as the CLI names it. */
export const TIKTOK_SERVER = "claude.ai TikTok for Business";
const PREFIX = "mcp__claude_ai_TikTok_for_Business__";
export const TIKTOK_TOOLS = {
  accounts: `${PREFIX}auth_advertiser_get`,
  report: `${PREFIX}report_integrated_get`,
  execute: `${PREFIX}tool_execute`,
} as const;
/** The only API the generic dispatcher may reach; it reads ads and changes nothing. */
const EXECUTE_ALLOWED = new Set(["ad_get"]);

export type PlannedCall = { tool: string; input: Record<string, unknown> };
type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

/** Permit exactly the planned call: same tool, deep-equal arguments. Everything else is refused before it runs. */
export function createProxyGuard(call: PlannedCall): (tool: string, input: Record<string, unknown>) => Promise<Decision> {
  if (call.tool === TIKTOK_TOOLS.execute && !EXECUTE_ALLOWED.has(String(call.input.tool_name))) {
    throw new Error("tool_execute is limited to ad_get");
  }
  if (!Object.values(TIKTOK_TOOLS).includes(call.tool as never)) throw new Error(`Not a planned TikTok tool: ${call.tool}`);
  return async (tool, input) => tool === call.tool && isDeepStrictEqual(input, call.input)
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "Only the planned call with the exact arguments is allowed." };
}

type StreamMessage = { type: string; message?: { content?: unknown } };

/** Where the CLI saves tool results that exceed its output limit. */
export const SAVED_RESULTS_ROOT = join(homedir(), ".claude", "projects");
const SAVED_NOTE = /^Error: result \([\d,]+ characters[^)]*\) exceeds maximum allowed tokens\. Output has been saved to (\S+?)\.\s/;

/** A result too large for the CLI arrives as a note pointing at the saved file; read the raw output from there. */
function savedResult(text: string, root: string): string | null {
  const match = text.match(SAVED_NOTE);
  if (!match) return null;
  const path = realpathSync(match[1]!);
  const base = realpathSync(root);
  if (!path.startsWith(base + sep) || !/TikTok_for_Business/.test(path)) throw new Error(`Saved tool result is outside ${root}`);
  return readFileSync(path, "utf8");
}

/** The raw TikTok response of the planned tool, taken from the tool result itself; the model's own reply is ignored. */
export function extractToolResult(messages: readonly StreamMessage[], tool: string, savedRoot = SAVED_RESULTS_ROOT): unknown {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== "assistant" || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content as Array<{ type: string; id?: string; name?: string }>) {
      if (block.type === "tool_use" && block.name === tool && block.id) ids.add(block.id);
    }
  }
  for (const message of messages) {
    if (message.type !== "user" || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type !== "tool_result" || !block.tool_use_id || !ids.has(block.tool_use_id) || block.is_error) continue;
      const parts = Array.isArray(block.content) ? block.content as Array<{ type: string; text?: string }> : [{ type: "text", text: String(block.content) }];
      const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      return JSON.parse(savedResult(text, savedRoot) ?? text) as unknown;
    }
  }
  throw new Error(`no tool result for ${tool}`);
}

export class ConnectorUnavailableError extends Error {}

/**
 * Run one planned call through a short Claude session that can use the owner's claude.ai TikTok connector.
 * The session waits for the connector, may call only the planned tool with the planned arguments, and its reply is discarded.
 */
export async function runProxyCall(call: PlannedCall, deps: { query?: typeof query; model?: string; connectTimeoutMs?: number } = {}): Promise<unknown> {
  const guard = createProxyGuard(call);
  const run = deps.query ?? query;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  async function* prompt() {
    await ready;
    yield {
      type: "user" as const, parent_tool_use_id: null,
      message: { role: "user" as const, content: `Call the tool ${call.tool} exactly once with exactly these arguments (JSON): ${JSON.stringify(call.input)}\nDo not call any other tool. Then reply DONE.` },
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3 * 60_000);
  const env = Object.fromEntries(Object.entries(childEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const session = run({ prompt: prompt(), options: {
    model: deps.model ?? "claude-haiku-5-5", cwd: "/tmp", tools: [], settingSources: [], permissionMode: "default",
    canUseTool: guard, maxTurns: 4, abortController: controller, pathToClaudeCodeExecutable: "claude", env,
  } });
  const messages: StreamMessage[] = [];
  try {
    const deadline = Date.now() + (deps.connectTimeoutMs ?? 60_000);
    // claude.ai connectors connect after start-up; asking before that leaves the model without the tool.
    for (;;) {
      const status = (await session.mcpServerStatus()).find((server) => server.name === TIKTOK_SERVER)?.status;
      if (status === "connected") break;
      if (status === "failed" || status === "needs-auth" || status === "disabled") throw new ConnectorUnavailableError(`TikTok connector is ${status}`);
      if (Date.now() > deadline) throw new ConnectorUnavailableError("TikTok connector did not connect in time");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    release();
    for await (const message of session as AsyncIterable<StreamMessage>) {
      messages.push(message);
      if (message.type === "result") break;
    }
  } finally {
    clearTimeout(timer);
    release();
    controller.abort();
  }
  return extractToolResult(messages, call.tool);
}

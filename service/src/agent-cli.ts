import { resetAgentThread, runAgentTurn } from "./agent/agent.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

/** `npm run agent -- [--thread name] [--new] "question"` talks to the Content Lab agent from the terminal. */
const args = process.argv.slice(2);
const threadIndex = args.indexOf("--thread");
const thread = threadIndex >= 0 ? args[threadIndex + 1] ?? "cli" : "cli";
const text = args.filter((arg, index) => !arg.startsWith("--") && index !== threadIndex + 1).join(" ").trim();
const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  if (args.includes("--new")) resetAgentThread(db, `cli:${thread}`);
  if (!text) throw new Error('Usage: npm run agent -- [--thread name] [--new] "question"');
  const turn = await runAgentTurn(db, config, { threadKey: `cli:${thread}`, channel: "cli", author: process.env.USER ?? null, text });
  console.log(turn.reply);
  console.error(JSON.stringify({ toolCalls: turn.toolCalls, seconds: Math.round(turn.durationMs / 1000), sessionId: turn.sessionId }));
} finally {
  db.close();
}

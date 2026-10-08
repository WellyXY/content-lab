import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { promisify } from "node:util";

import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

const execFileAsync = promisify(execFile);
type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string };
const checks: Check[] = [];
const add = (name: string, status: Check["status"], detail: string): void => { checks.push({ name, status, detail }); };
const config = loadConfig();

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const minor = Number.parseInt(process.versions.node.split(".")[1] ?? "0", 10);
const nodeReady = major > 22 || (major === 22 && minor >= 5);
add("node", nodeReady ? "ok" : "fail", `Node ${process.versions.node}; version 22.5 or newer is required for node:sqlite`);
const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(config.host.toLowerCase());
add("listen-address", loopback ? "ok" : "fail", loopback ? `HTTP binds to loopback (${config.host})` : `HOST=${config.host} would expose the Codex-adjacent service beyond loopback`);

try {
  const db = openDatabase(config.dbPath);
  db.prepare("SELECT 1").get();
  db.close();
  add("sqlite", "ok", "Database opens, migrations apply, and WAL mode is enabled");
} catch (error) { add("sqlite", "fail", error instanceof Error ? error.message : String(error)); }

try {
  JSON.parse(readFileSync(config.taxonomyPath, "utf8"));
  accessSync(config.taxonomyPath, constants.R_OK);
  add("taxonomy", "ok", "Taxonomy v3 is readable JSON");
} catch (error) { add("taxonomy", "fail", error instanceof Error ? error.message : String(error)); }

for (const [name, args] of [
  ["codex", ["login", "status"]],
  ["ffmpeg", ["-version"]],
] as const) {
  try {
    const result = await execFileAsync(name, [...args], { timeout: 10_000, maxBuffer: 256 * 1024 });
    const detail = `${result.stdout || result.stderr}`.trim().split("\n")[0] || `${name} is available`;
    add(name, "ok", detail);
  } catch (error) {
    add(name, "fail", `${name} is unavailable or not ready`);
  }
}

if (config.feishuWebhookUrl) {
  try {
    const url = new URL(config.feishuWebhookUrl);
    add("feishu", url.protocol === "https:" ? "ok" : "fail", url.protocol === "https:" ? "Webhook is configured (not invoked by doctor)" : "Webhook must use HTTPS");
  } catch { add("feishu", "fail", "FEISHU_WEBHOOK_URL is not a valid URL"); }
} else add("feishu", "warn", "FEISHU_WEBHOOK_URL is not configured; alerts remain in the local outbox");

if ((config.siteSyncUrl && !config.siteSyncToken) || (!config.siteSyncUrl && config.siteSyncToken)) {
  add("site-sync", "fail", "SITE_SYNC_URL and SITE_SYNC_TOKEN must be configured together");
} else if (config.siteSyncUrl) {
  try {
    const url = new URL(config.siteSyncUrl);
    add("site-sync", url.protocol === "https:" ? "ok" : "warn", url.protocol === "https:" ? "Outbound GPT Site sync is configured" : "Use HTTPS outside local development");
  } catch { add("site-sync", "fail", "SITE_SYNC_URL is not a valid URL"); }
} else add("site-sync", "warn", "GPT Site sync is disabled; local API remains available");

console.log(JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2));
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;

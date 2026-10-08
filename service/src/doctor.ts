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
  config.analyzerProvider === "claude" ? ["claude", ["auth", "status"]] as const : ["codex", ["login", "status"]] as const,
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

const feishuCredentialsComplete = Boolean(config.feishuAppId && config.feishuAppSecret);
if (Boolean(config.feishuAppId) !== Boolean(config.feishuAppSecret)) {
  add("feishu-bot", "fail", "FEISHU_APP_ID and FEISHU_APP_SECRET must be configured together");
} else if (feishuCredentialsComplete) {
  const appIdValid = /^cli_[A-Za-z0-9]+$/.test(config.feishuAppId ?? "");
  add("feishu-bot", appIdValid ? "ok" : "fail", appIdValid ? "App Bot credentials are configured (not printed or invoked by doctor)" : "FEISHU_APP_ID must start with cli_");
  const invalidSenders = config.feishuAllowedSenderIds.filter((id) => !/^ou_[A-Za-z0-9_-]+$/.test(id));
  const invalidChats = config.feishuAllowedChatIds.filter((id) => !/^oc_[A-Za-z0-9_-]+$/.test(id));
  add("feishu-query-allowlist", invalidSenders.length === 0 && invalidChats.length === 0 ? "ok" : "fail",
    invalidSenders.length === 0 && invalidChats.length === 0
      ? `DM senders: ${config.feishuAllowedSenderIds.length}; group chats: ${config.feishuAllowedChatIds.length}; unlisted traffic is denied`
      : "Allowlist IDs must use Feishu open_id (ou_) or chat_id (oc_) values");
  if (config.feishuAllowedSenderIds.length === 0) {
    add("feishu-query-access", "warn", "The sender allowlist is empty; all inbound queries are intentionally disabled");
  }
} else {
  add("feishu-bot", "warn", "FEISHU_APP_ID/FEISHU_APP_SECRET are not configured; App Bot and inbound queries are disabled");
}

if (config.feishuAlertChatId && config.feishuAlertOpenId) {
  add("feishu-alert-target", "fail", "Set only one of FEISHU_ALERT_CHAT_ID or FEISHU_ALERT_OPEN_ID");
} else if (config.feishuAlertChatId) {
  add("feishu-alert-chat", feishuCredentialsComplete && /^oc_[A-Za-z0-9_-]+$/.test(config.feishuAlertChatId) ? "ok" : "fail",
    feishuCredentialsComplete ? "App Bot alert target is configured" : "FEISHU_ALERT_CHAT_ID requires App Bot credentials");
} else if (config.feishuAlertOpenId) {
  add("feishu-alert-user", feishuCredentialsComplete && /^ou_[A-Za-z0-9_-]+$/.test(config.feishuAlertOpenId) ? "ok" : "fail",
    feishuCredentialsComplete ? "App Bot direct-message alert target is configured" : "FEISHU_ALERT_OPEN_ID requires App Bot credentials");
}

if (config.feishuWebhookUrl) {
  try {
    const url = new URL(config.feishuWebhookUrl);
    add("feishu-webhook-fallback", url.protocol === "https:" ? "ok" : "fail", url.protocol === "https:" ? "Webhook fallback is configured (not invoked by doctor)" : "Webhook must use HTTPS");
  } catch { add("feishu-webhook-fallback", "fail", "FEISHU_WEBHOOK_URL is not a valid URL"); }
} else if (!config.feishuAlertChatId && !config.feishuAlertOpenId) add("feishu-alerts", "warn", "No App Bot target or webhook is configured; alerts remain in the local outbox");

if (config.feishuAlertChatId || config.feishuAlertOpenId || config.feishuWebhookUrl) {
  try {
    const url = new URL(config.publicBaseUrl);
    const publicLink = url.protocol === "https:" && !new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
    add("feishu-alert-links", publicLink ? "ok" : "fail", publicLink ? `Alert links use ${url.origin}` : "PUBLIC_BASE_URL must be a public HTTPS origin when Feishu alerts are enabled");
  } catch { add("feishu-alert-links", "fail", "PUBLIC_BASE_URL is not a valid URL"); }
}

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

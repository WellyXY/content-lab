import { dirname, resolve } from "node:path";

export interface ServiceConfig {
  host: string;
  port: number;
  dbPath: string;
  mediaDir: string;
  taxonomyPath: string;
  publicBaseUrl: string;
  bindHourlyPerIp: number;
  analysisRetryHourlyPerIp: number;
  dailyNewPosts: number;
  maxActivePosts: number;
  bindSecret: string | null;
  turnstileSecret: string | null;
  feishuAppId: string | null;
  feishuAppSecret: string | null;
  feishuAlertChatId: string | null;
  feishuAlertOpenId: string | null;
  feishuAllowedSenderIds: string[];
  feishuAllowedChatIds: string[];
  feishuBotLockPath: string;
  feishuWebhookUrl: string | null;
  siteSyncUrl: string | null;
  siteSyncToken: string | null;
  workerId: string;
  analyzerProvider: "claude" | "codex";
  claudeModel: string;
  codexModel: string | null;
  codexConcurrency: number;
  tikwmMinIntervalMs: number;
}

const integer = (name: string, fallback: number, min = 0): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
};

const optional = (name: string): string | null => process.env[name]?.trim() || null;
const analyzerProvider = (): "claude" | "codex" => {
  const value = optional("ANALYZER_PROVIDER") ?? "claude";
  if (value !== "claude" && value !== "codex") throw new Error("ANALYZER_PROVIDER must be claude or codex");
  return value;
};
const list = (name: string): string[] => [...new Set((process.env[name] ?? "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];

export function loadConfig(): ServiceConfig {
  const serviceDir = resolve(import.meta.dirname, "..");
  const repoDir = resolve(serviceDir, "..");
  const dbPath = resolve(process.env.CONTENT_LAB_DB || resolve(repoDir, "var/content-lab.sqlite"));
  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: integer("PORT", 4320, 1),
    dbPath,
    mediaDir: resolve(process.env.CONTENT_LAB_MEDIA_DIR || resolve(repoDir, "var/media")),
    taxonomyPath: resolve(process.env.CONTENT_LAB_TAXONOMY || resolve(repoDir, "docs/taxonomy/v3.json")),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || "http://127.0.0.1:4320",
    bindHourlyPerIp: integer("BIND_HOURLY_PER_IP", 30, 1),
    analysisRetryHourlyPerIp: integer("ANALYSIS_RETRY_HOURLY_PER_IP", 10, 1),
    dailyNewPosts: integer("DAILY_NEW_POSTS", 300, 1),
    maxActivePosts: integer("MAX_ACTIVE_POSTS", 1_000, 1),
    bindSecret: optional("BIND_SECRET"),
    turnstileSecret: optional("TURNSTILE_SECRET"),
    feishuAppId: optional("FEISHU_APP_ID"),
    feishuAppSecret: optional("FEISHU_APP_SECRET"),
    feishuAlertChatId: optional("FEISHU_ALERT_CHAT_ID"),
    feishuAlertOpenId: optional("FEISHU_ALERT_OPEN_ID"),
    feishuAllowedSenderIds: list("FEISHU_ALLOWED_SENDER_IDS"),
    feishuAllowedChatIds: list("FEISHU_ALLOWED_CHAT_IDS"),
    feishuBotLockPath: resolve(process.env.FEISHU_BOT_LOCK || resolve(dirname(dbPath), "feishu-bot.lock")),
    feishuWebhookUrl: optional("FEISHU_WEBHOOK_URL"),
    siteSyncUrl: optional("SITE_SYNC_URL")?.replace(/\/$/, "") ?? null,
    siteSyncToken: optional("SITE_SYNC_TOKEN"),
    workerId: process.env.CONTENT_LAB_WORKER_ID?.trim() || `mac-${process.pid}`,
    analyzerProvider: analyzerProvider(),
    claudeModel: optional("CLAUDE_MODEL") ?? "claude-opus-5-5",
    codexModel: optional("CODEX_MODEL"),
    codexConcurrency: integer("CODEX_CONCURRENCY", 1, 1),
    tikwmMinIntervalMs: integer("TIKWM_MIN_INTERVAL_MS", 1_250, 0),
  };
}

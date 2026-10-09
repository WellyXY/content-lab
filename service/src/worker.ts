import { createHash } from "node:crypto";

import { resetAgentThread, runAgentTurn } from "./agent/agent.js";
import { AnalyzerQuotaError } from "./analyzer/claude.js";
import { CodexAuthError, analyzePost } from "./analyzer/codex.js";
import { assessPost, generatePlaybook, marketWeekStart, marketsDueForPlaybook, postsAwaitingAssessment } from "./analyzer/playbook.js";
import { capturePost, ingestPost, recordCodexAuthAlert, refreshPostMetadata, syncPostReadModel } from "./collector.js";
import { loadConfig } from "./config.js";
import { openDatabase, type ContentLabDatabase } from "./db/database.js";
import { normalizeTikTokPostUrl } from "./domain/tiktok-url.js";
import { createContentLabFeishuBot } from "./feishu/bot.js";
import { createFeishuWebhookTransport, deliverAlertOutbox, type FeishuAlertTransport } from "./feishu.js";
import { completeJob, deferJob, enqueueJob, failJob, leaseJobs, type Job } from "./jobs/queue.js";
import { TikTokProvider } from "./providers/tiktok.js";
import { runSchedulerCycle } from "./scheduler.js";
import { flushSyncOutbox, pullRemoteJobs, SiteSyncClient } from "./sync/client.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const provider = new TikTokProvider({ minIntervalMs: config.tikwmMinIntervalMs });
const syncClient = config.siteSyncUrl && config.siteSyncToken
  ? new SiteSyncClient({ baseUrl: config.siteSyncUrl, token: config.siteSyncToken, workerId: config.workerId })
  : null;

const log = (event: string, detail: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
};

if (config.feishuAlertChatId && config.feishuAlertOpenId) {
  throw new Error("Set only one of FEISHU_ALERT_CHAT_ID or FEISHU_ALERT_OPEN_ID");
}

const feishuBot = config.feishuAppId && config.feishuAppSecret ? createContentLabFeishuBot({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  alertChatId: config.feishuAlertChatId,
  alertOpenId: config.feishuAlertOpenId,
  allowedSenderIds: config.feishuAllowedSenderIds,
  allowedChatIds: config.feishuAllowedChatIds,
  lockPath: config.feishuBotLockPath,
  db,
  agent: {
    answer: async ({ threadKey, author, role, text }) => (await runAgentTurn(db, config, { threadKey, channel: "feishu", author, role, text })).reply,
    reset: (threadKey) => resetAgentThread(db, threadKey),
  },
  log,
}) : null;

const alertTransports: FeishuAlertTransport[] = [
  feishuBot?.alertTransport ?? null,
  config.feishuWebhookUrl ? createFeishuWebhookTransport(config.feishuWebhookUrl) : null,
].filter((transport): transport is FeishuAlertTransport => transport !== null);

async function pushPendingEvents(): Promise<void> {
  if (!syncClient) return;
  try {
    const count = await flushSyncOutbox(db, syncClient, 50, { includeDeletes: config.siteDeleteSync });
    if (count > 0) log("site_events_pushed", { count });
  } catch (error) {
    log("site_push_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function processJob(database: ContentLabDatabase, job: Job): Promise<void> {
  if (job.kind === "ingest") {
    await ingestPost(database, provider, job.payload as { url: string; market?: string | null; projectTag?: string | null; boundBy?: string | null; sitePostId?: string | null });
    return;
  }
  if (job.kind === "capture") {
    const payload = job.payload as { postId?: string };
    if (!payload.postId) throw new Error("Capture job is missing postId");
    await capturePost(database, provider, payload.postId);
    return;
  }
  if (job.kind === "analyze") {
    const payload = job.payload as { postId?: string; version?: number };
    if (!payload.postId) throw new Error("Analyze job is missing postId");
    const post = database.prepare("SELECT type FROM posts WHERE id=?").get(payload.postId) as { type: string | null } | undefined;
    // Carousel image URLs are signed and expire; refresh them before downloading every image.
    if (post?.type === "photo") await refreshPostMetadata(database, provider, payload.postId);
    await analyzePost(database, config, payload.postId, payload.version ?? 1);
    return;
  }
  if (job.kind === "playbook") {
    const { market } = job.payload as { market?: string };
    if (!market) throw new Error("Playbook job is missing market");
    const playbook = await generatePlaybook(database, config, market);
    for (const target of postsAwaitingAssessment(database, market)) {
      enqueueJob(database, { kind: "assess", payload: { postId: target.postId, version: target.version }, idempotencyKey: `assess:${target.postId}:v${target.version}:pb${playbook.version}` });
    }
    log("playbook_generated", { market, version: playbook.version, patterns: playbook.document.patterns.length });
    return;
  }
  if (job.kind === "assess") {
    const payload = job.payload as { postId?: string; version?: number };
    if (!payload.postId || !payload.version) throw new Error("Assess job is missing postId or version");
    await assessPost(database, config, payload.postId, payload.version);
    return;
  }
  if (job.kind === "remote_bind") {
    if (!syncClient || !job.syncRemoteId) throw new Error("Remote bind job cannot run without site sync configuration");
    const payload = job.payload as { urls?: string[]; sitePostId?: string; market?: string | null; projectTag?: string | null; boundBy?: string | null };
    if (!Array.isArray(payload.urls) || payload.urls.length < 1 || payload.urls.length > 50) throw new Error("Remote bind job has an invalid URL batch");
    const urls = [...new Set(payload.urls.map(normalizeTikTokPostUrl))];
    if (payload.sitePostId && urls.length !== 1) throw new Error("A sitePostId remote bind job must contain exactly one URL");
    for (const url of urls) {
      enqueueJob(database, {
        kind: "ingest", payload: { url, sitePostId: payload.sitePostId ?? null, market: payload.market ?? null, projectTag: payload.projectTag ?? null, boundBy: payload.boundBy ?? "gpt-site" },
        idempotencyKey: `ingest:${createHash("sha256").update(url).digest("hex")}`,
      });
    }
    await syncClient.completeJob(job.syncRemoteId);
    return;
  }
  if (job.kind === "remote_analyze") {
    if (!syncClient || !job.syncRemoteId) throw new Error("Remote analyze job cannot run without site sync configuration");
    const { sitePostId } = job.payload as { sitePostId?: string };
    const post = database.prepare("SELECT id FROM posts WHERE site_post_id=? OR id=? LIMIT 1").get(sitePostId ?? "", sitePostId ?? "") as { id: string } | undefined;
    if (!post) throw new Error(`No local post for hosted post ${sitePostId}`);
    const latest = database.prepare("SELECT MAX(version) AS version FROM post_features WHERE post_id=?").get(post.id) as { version: number | null };
    const version = (latest.version ?? 0) + 1;
    enqueueJob(database, { kind: "analyze", payload: { postId: post.id, version }, idempotencyKey: `site-analyze:${job.syncRemoteId}` });
    const now = new Date().toISOString();
    database.prepare("UPDATE posts SET features_state='pending', updated_at=? WHERE id=?").run(now, post.id);
    syncPostReadModel(database, post.id, now);
    await syncClient.completeJob(job.syncRemoteId);
    return;
  }
  throw new Error(`Unsupported job kind: ${job.kind}`);
}

const QUOTA_PAUSE_MS = 30 * 60_000;
/** Jobs that call the model share the analysis pool and its quota pause. */
const MODEL_JOB_KINDS = ["analyze", "assess", "playbook"];
const ANALYSIS_LEASE_MS = 20 * 60_000;
const inflightAnalyses = new Set<Promise<void>>();
let analysisPausedUntil = 0;

async function handleJob(job: Job): Promise<void> {
  try {
    await processJob(db, job);
    completeJob(db, job.id);
    log("job_completed", { jobId: job.id, kind: job.kind });
  } catch (error) {
    if (error instanceof AnalyzerQuotaError) {
      // The subscription window is exhausted: wait for it instead of burning retries.
      analysisPausedUntil = Date.now() + QUOTA_PAUSE_MS;
      deferJob(db, job.id, new Date(analysisPausedUntil).toISOString(), error.message);
      log("analysis_paused_for_quota", { jobId: job.id, until: new Date(analysisPausedUntil).toISOString() });
      return;
    }
    if (error instanceof CodexAuthError) recordCodexAuthAlert(db, error.message, config.analyzerProvider === "claude" ? "Run `claude` on the Mac and sign in with /login" : "Run `codex login` on the Mac");
    failJob(db, job.id, error);
    const state = db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id) as { status: string };
    if (job.kind === "analyze" && state.status === "dead") {
      const payload = job.payload as { postId?: string };
      if (payload.postId) {
        const now = new Date().toISOString();
        db.prepare("UPDATE posts SET features_state='features_failed', updated_at=? WHERE id=?").run(now, payload.postId);
        syncPostReadModel(db, payload.postId, now);
      }
    }
    if ((job.kind === "remote_bind" || job.kind === "remote_analyze") && syncClient && job.syncRemoteId) {
      try { await syncClient.failJob(job.syncRemoteId, error instanceof Error ? error.message : String(error), state.status !== "dead"); }
      catch (syncError) { log("site_job_fail_ack_failed", { jobId: job.id, error: syncError instanceof Error ? syncError.message : String(syncError) }); }
    }
    log("job_failed", { jobId: job.id, kind: job.kind, status: state.status, error: error instanceof Error ? error.message : String(error) });
  }
  // Publish real metadata, metrics and analyses as soon as each job settles.
  await pushPendingEvents();
}

/** Fill the analysis pool; each analysis runs alongside captures instead of blocking them. */
function startAnalyses(): void {
  if (Date.now() < analysisPausedUntil) return;
  while (inflightAnalyses.size < config.analyzerConcurrency) {
    const job = leaseJobs(db, { workerId: config.workerId, limit: 1, leaseMs: ANALYSIS_LEASE_MS, kinds: MODEL_JOB_KINDS })[0];
    if (!job) return;
    const task: Promise<void> = handleJob(job).finally(() => { inflightAnalyses.delete(task); });
    inflightAnalyses.add(task);
  }
}

export async function runWorkerCycle(): Promise<void> {
  if (syncClient) {
    try { log("site_jobs_pulled", { count: await pullRemoteJobs(db, syncClient) }); }
    catch (error) { log("site_pull_failed", { error: error instanceof Error ? error.message : String(error) }); }
  }
  log("scheduler_cycle", { ...runSchedulerCycle(db) });
  const now = new Date().toISOString();
  for (const market of marketsDueForPlaybook(db, now)) {
    enqueueJob(db, { kind: "playbook", payload: { market }, idempotencyKey: `playbook:${market}:${marketWeekStart(market, now)}` });
  }
  await pushPendingEvents();
  startAnalyses();
  for (let processed = 0; processed < 20; processed += 1) {
    const job = leaseJobs(db, { workerId: config.workerId, limit: 1, leaseMs: ANALYSIS_LEASE_MS, excludeKinds: MODEL_JOB_KINDS })[0];
    if (!job) break;
    await handleJob(job);
    // An ingest enqueues its analysis; start it right away.
    startAnalyses();
  }
  const delivery = await deliverAlertOutbox(db, alertTransports, config.publicBaseUrl);
  if (delivery.delivered > 0 || delivery.failed > 0) log("alert_delivery", delivery);
  await pushPendingEvents();
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      const started = Date.now();
      if (!once && feishuBot && !["connected", "connecting", "reconnecting"].includes(feishuBot.connectionStatus()?.state ?? "idle")) {
        try {
          await feishuBot.connect();
          log("feishu_bot_connected", { bot: feishuBot.identity()?.name ?? "unknown" });
        } catch (error) {
          log("feishu_bot_connect_failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      try { await runWorkerCycle(); } catch (error) { log("worker_cycle_failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
      if (once) await Promise.allSettled([...inflightAnalyses]);
      if (once || stopping) break;
      // Analyses are refilled between cycles, so only other due work shortens the wait.
      const due = db.prepare("SELECT 1 FROM jobs WHERE kind NOT IN ('analyze','assess','playbook') AND status IN ('queued','failed') AND run_at<=? AND attempts<max_attempts LIMIT 1")
        .get(new Date().toISOString());
      const until = Date.now() + (due ? 1_000 : Math.max(1_000, 30_000 - (Date.now() - started)));
      while (!stopping && Date.now() < until) {
        try { startAnalyses(); } catch (error) { log("analysis_start_failed", { error: error instanceof Error ? error.message : String(error) }); }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(0, until - Date.now()))));
      }
    } while (!stopping);
    await Promise.allSettled([...inflightAnalyses]);
  } finally {
    if (feishuBot) {
      try { await feishuBot.disconnect(); } catch (error) { log("feishu_bot_disconnect_failed", { error: error instanceof Error ? error.message : String(error) }); }
    }
    db.close();
  }
}

await main();

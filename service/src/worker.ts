import { createHash } from "node:crypto";

import { CodexAuthError, analyzePost } from "./analyzer/codex.js";
import { capturePost, ingestPost, recordCodexAuthAlert, syncPostReadModel } from "./collector.js";
import { loadConfig } from "./config.js";
import { openDatabase, type ContentLabDatabase } from "./db/database.js";
import { normalizeTikTokUrl } from "./domain/tiktok-url.js";
import { deliverAlertOutbox } from "./feishu.js";
import { completeJob, enqueueJob, failJob, leaseJobs, type Job } from "./jobs/queue.js";
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
    await analyzePost(database, config, payload.postId, payload.version ?? 1);
    return;
  }
  if (job.kind === "remote_bind") {
    if (!syncClient || !job.syncRemoteId) throw new Error("Remote bind job cannot run without site sync configuration");
    const payload = job.payload as { urls?: string[]; sitePostId?: string; market?: string | null; projectTag?: string | null; boundBy?: string | null };
    if (!Array.isArray(payload.urls) || payload.urls.length < 1 || payload.urls.length > 50) throw new Error("Remote bind job has an invalid URL batch");
    const urls = [...new Set(payload.urls.map(normalizeTikTokUrl))];
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
  throw new Error(`Unsupported job kind: ${job.kind}`);
}

export async function runWorkerCycle(): Promise<void> {
  if (syncClient) {
    try { log("site_jobs_pulled", { count: await pullRemoteJobs(db, syncClient) }); }
    catch (error) { log("site_pull_failed", { error: error instanceof Error ? error.message : String(error) }); }
  }
  log("scheduler_cycle", { ...runSchedulerCycle(db) });
  for (let processed = 0; processed < 20; processed += 1) {
    const job = leaseJobs(db, { workerId: config.workerId, limit: 1, leaseMs: 20 * 60_000 })[0];
    if (!job) break;
    try {
      await processJob(db, job);
      completeJob(db, job.id);
      log("job_completed", { jobId: job.id, kind: job.kind });
    } catch (error) {
      if (error instanceof CodexAuthError) recordCodexAuthAlert(db, error.message);
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
      if (job.kind === "remote_bind" && syncClient && job.syncRemoteId) {
        try { await syncClient.failJob(job.syncRemoteId, error instanceof Error ? error.message : String(error), state.status !== "dead"); }
        catch (syncError) { log("site_job_fail_ack_failed", { jobId: job.id, error: syncError instanceof Error ? syncError.message : String(syncError) }); }
      }
      log("job_failed", { jobId: job.id, kind: job.kind, status: state.status, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const delivery = await deliverAlertOutbox(db, config.feishuWebhookUrl, config.publicBaseUrl);
  if (delivery.delivered > 0 || delivery.failed > 0) log("alert_delivery", delivery);
  if (syncClient) {
    try { log("site_events_pushed", { count: await flushSyncOutbox(db, syncClient) }); }
    catch (error) { log("site_push_failed", { error: error instanceof Error ? error.message : String(error) }); }
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    const started = Date.now();
    try { await runWorkerCycle(); } catch (error) { log("worker_cycle_failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
    if (once || stopping) break;
    const wait = Math.max(1_000, 5 * 60_000 - (Date.now() - started));
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  } while (!stopping);
  db.close();
}

await main();

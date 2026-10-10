import { randomUUID } from "node:crypto";

import { syncPostReadModel } from "../collector.js";
import type { ContentLabDatabase } from "../db/database.js";
import { parseAccounts, parseAdLinks, parseReportRows } from "./parse.js";
import { accountDate, postAdsSummary, storeAdLinks, storeDaily, storeLifetime } from "./store.js";
import { accountsCall, adLinkCalls, dailyCalls, lifetimeCalls, withPage } from "./plan.js";
import type { PlannedCall } from "./proxy.js";

export const ADS_MAX_CALLS = 60;
class BudgetExhausted extends Error {}

export interface AdsSyncResult { status: "ok" | "partial" | "failed"; calls: number; accounts: number; linkedAds: number; posts: number; error?: string }

/**
 * Link Spark Ads to tracked posts and refresh their delivery metrics. Every API call is planned here and
 * executed through `deps.call`; a run stops at the call budget and the next run picks up from the last complete step.
 */
export async function runAdsSync(db: ContentLabDatabase, deps: { call: (call: PlannedCall) => Promise<unknown> }, now = new Date(), options: { maxCalls?: number } = {}): Promise<AdsSyncResult> {
  const maxCalls = options.maxCalls ?? ADS_MAX_CALLS;
  const at = now.toISOString();
  const runId = randomUUID();
  db.prepare("INSERT INTO ad_sync_runs(id, started_at, calls, status) VALUES (?, ?, 0, 'running')").run(runId, at);
  let calls = 0;
  const request = async (call: PlannedCall): Promise<unknown> => {
    if (calls >= maxCalls) throw new BudgetExhausted();
    calls += 1;
    try {
      return await deps.call(call);
    } catch (error) {
      // A proxy session occasionally ends without calling the tool; one retry covers it.
      if (calls >= maxCalls) throw error;
      calls += 1;
      return deps.call(call);
    }
  };
  /** Follow pages of one planned call until the API says there are no more. */
  const paged = async <T>(call: PlannedCall, parse: (raw: unknown) => { morePages: boolean } & T, handle: (page: T) => void): Promise<void> => {
    for (let page = 1; ; page += 1) {
      const parsed = parse(await request(withPage(call, page)));
      handle(parsed);
      if (!parsed.morePages) return;
    }
  };
  const result: AdsSyncResult = { status: "ok", calls: 0, accounts: 0, linkedAds: 0, posts: 0 };
  try {
    const accounts = parseAccounts(await request(accountsCall()));
    result.accounts = accounts.length;
    const upsertAccount = db.prepare(`INSERT INTO ad_accounts(advertiser_id, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(advertiser_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`);
    for (const account of accounts) upsertAccount.run(account.advertiserId, account.name, at);

    for (const account of accounts) {
      const scanned = db.prepare("SELECT last_link_scan_at FROM ad_accounts WHERE advertiser_id=?").get(account.advertiserId) as { last_link_scan_at: string | null };
      for (const call of adLinkCalls(account.advertiserId, scanned.last_link_scan_at, 1)) {
        await paged(call, parseAdLinks, (page) => storeAdLinks(db, account.advertiserId, page.links, at));
      }
      // Only a complete scan moves the cursor, so an interrupted one is repeated next time.
      db.prepare("UPDATE ad_accounts SET last_link_scan_at=? WHERE advertiser_id=?").run(at, account.advertiserId);
    }

    const tracked = db.prepare(`SELECT l.ad_id, l.advertiser_id FROM ad_links l JOIN posts p ON p.video_id=l.tiktok_item_id ORDER BY l.advertiser_id, l.ad_id`).all() as Array<{ ad_id: string; advertiser_id: string }>;
    result.linkedAds = tracked.length;
    const byAccount = new Map<string, string[]>();
    for (const row of tracked) byAccount.set(row.advertiser_id, [...(byAccount.get(row.advertiser_id) ?? []), row.ad_id]);
    for (const [advertiserId, adIds] of byAccount) {
      for (const call of lifetimeCalls(advertiserId, adIds)) await paged(call, parseReportRows, (page) => storeLifetime(db, page.rows, at));
      for (const call of dailyCalls(advertiserId, adIds, accountDate(now))) await paged(call, parseReportRows, (page) => storeDaily(db, page.rows, at));
    }
  } catch (error) {
    if (error instanceof BudgetExhausted) result.status = "partial";
    else { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); }
  } finally {
    result.calls = calls;
    // A complete run re-sends every promoted post, so a push the Site dropped (e.g. before a release) heals within a day.
    result.posts = refreshPostAds(db, now, { resendAll: result.status === "ok" });
    db.prepare("UPDATE ad_sync_runs SET finished_at=?, calls=?, status=?, error=? WHERE id=?").run(new Date().toISOString(), calls, result.status, result.error ?? null, runId);
  }
  return result;
}

/** Recompute each promoted post's summary; posts whose summary changed (or all of them with `resendAll`) are synced to the Site. */
export function refreshPostAds(db: ContentLabDatabase, now = new Date(), options: { resendAll?: boolean } = {}): number {
  const posts = db.prepare(`SELECT DISTINCT p.id, p.ads_json FROM posts p JOIN ad_links l ON l.tiktok_item_id=p.video_id`).all() as Array<{ id: string; ads_json: string | null }>;
  let changed = 0;
  for (const post of posts) {
    const json = JSON.stringify(postAdsSummary(db, post.id, now));
    if (json === post.ads_json && !options.resendAll) continue;
    if (json !== post.ads_json) db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(json, post.id);
    syncPostReadModel(db, post.id, now.toISOString());
    changed += 1;
  }
  return changed;
}

import type { ContentLabDatabase } from "../db/database.js";
import type { AdLink, MetricRow } from "./parse.js";

export interface Totals { spend: number; impressions: number; clicks: number; installs: number; registrations: number; cpr: number | null; cpi: number | null; cpm: number | null; ctr: number | null }
export interface PostAdsSummary {
  status: "active" | "inactive";
  adCount: number; accounts: number;
  lifetime: Totals; last7d: Totals; prev7d: Totals;
  daily: Array<{ date: string; spend: number; registrations: number; installs: number }>;
  topAds: Array<{ adId: string; adName: string | null; campaignName: string | null; advertiserName: string | null } & Totals>;
  refreshedAt: string | null;
  currencyExcluded: number;
}

/** Most PopUp ad accounts report in UTC+8; dates follow that calendar. */
const ACCOUNT_OFFSET_HOURS = 8;
export const accountDate = (now: Date, minusDays = 0): string => new Date(now.getTime() + ACCOUNT_OFFSET_HOURS * 3_600_000 - minusDays * 86_400_000).toISOString().slice(0, 10);

/** Sum first, then divide; a zero denominator gives null, never 0. */
export function totals(rows: ReadonlyArray<{ spend: number; impressions: number; clicks: number; installs: number; registrations: number }>): Totals {
  const sum = (key: "spend" | "impressions" | "clicks" | "installs" | "registrations") => rows.reduce((total, row) => total + row[key], 0);
  const spend = sum("spend"); const impressions = sum("impressions"); const clicks = sum("clicks"); const installs = sum("installs"); const registrations = sum("registrations");
  return {
    spend, impressions, clicks, installs, registrations,
    cpr: registrations > 0 ? spend / registrations : null,
    cpi: installs > 0 ? spend / installs : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    ctr: impressions > 0 ? clicks / impressions : null,
  };
}

export function storeAdLinks(db: ContentLabDatabase, advertiserId: string, links: AdLink[], now: string): void {
  const statement = db.prepare(`INSERT INTO ad_links(ad_id, advertiser_id, tiktok_item_id, ad_name, campaign_id, campaign_name, adgroup_id, create_time, modify_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ad_id) DO UPDATE SET advertiser_id=excluded.advertiser_id, tiktok_item_id=COALESCE(excluded.tiktok_item_id, ad_links.tiktok_item_id),
      ad_name=excluded.ad_name, campaign_id=excluded.campaign_id, campaign_name=excluded.campaign_name, adgroup_id=excluded.adgroup_id,
      create_time=excluded.create_time, modify_time=excluded.modify_time, updated_at=excluded.updated_at`);
  // Only Spark Ads carry the original post; others can never match a tracked post.
  for (const link of links) if (link.itemId) statement.run(link.adId, advertiserId, link.itemId, link.adName, link.campaignId, link.campaignName, link.adgroupId, link.createTime, link.modifyTime, now);
}

export function storeLifetime(db: ContentLabDatabase, rows: MetricRow[], now: string): void {
  const statement = db.prepare(`INSERT INTO ad_lifetime(ad_id, spend, impressions, clicks, installs, registrations, video_plays, currency, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ad_id) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, installs=excluded.installs,
      registrations=excluded.registrations, video_plays=excluded.video_plays, currency=excluded.currency, refreshed_at=excluded.refreshed_at`);
  for (const row of rows) statement.run(row.adId, row.spend, row.impressions, row.clicks, row.installs, row.registrations, row.videoPlays, row.currency, now);
}

export function storeDaily(db: ContentLabDatabase, rows: MetricRow[], now: string): void {
  const statement = db.prepare(`INSERT INTO ad_daily(ad_id, stat_date, spend, impressions, clicks, installs, registrations, currency, timezone, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ad_id, stat_date) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, installs=excluded.installs,
      registrations=excluded.registrations, currency=excluded.currency, timezone=excluded.timezone, refreshed_at=excluded.refreshed_at`);
  for (const row of rows) if (row.date) statement.run(row.adId, row.date, row.spend, row.impressions, row.clicks, row.installs, row.registrations, row.currency, row.timezone, now);
}

type Row = { ad_id: string; spend: number; impressions: number; clicks: number; installs: number; registrations: number; currency: string | null };
const usd = (row: { currency: string | null }) => row.currency === null || row.currency === "USD";

/** Delivery totals of every Spark Ad that promotes this post, or null when it was never promoted. */
export function postAdsSummary(db: ContentLabDatabase, postId: string, now = new Date()): PostAdsSummary | null {
  const post = db.prepare("SELECT video_id FROM posts WHERE id=?").get(postId) as { video_id: string } | undefined;
  if (!post) return null;
  const links = db.prepare(`SELECT l.ad_id, l.ad_name, l.campaign_name, l.advertiser_id, a.name AS advertiser_name FROM ad_links l
    LEFT JOIN ad_accounts a ON a.advertiser_id=l.advertiser_id WHERE l.tiktok_item_id=?`).all(post.video_id) as Array<{ ad_id: string; ad_name: string | null; campaign_name: string | null; advertiser_id: string; advertiser_name: string | null }>;
  if (links.length === 0) return null;
  const ids = links.map((link) => link.ad_id);
  const marks = ids.map(() => "?").join(",");
  const lifetime = db.prepare(`SELECT ad_id, spend, impressions, clicks, installs, registrations, currency, refreshed_at FROM ad_lifetime WHERE ad_id IN (${marks})`).all(...ids) as Array<Row & { refreshed_at: string }>;
  const daily = db.prepare(`SELECT ad_id, stat_date, spend, impressions, clicks, installs, registrations, currency FROM ad_daily WHERE ad_id IN (${marks}) AND stat_date >= ?`).all(...ids, accountDate(now, 14)) as Array<Row & { stat_date: string }>;
  const counted = lifetime.filter(usd);
  const countedDaily = daily.filter(usd);
  const window = (from: number, to: number) => countedDaily.filter((row) => row.stat_date >= accountDate(now, from) && row.stat_date <= accountDate(now, to));
  const byAd = new Map(counted.map((row) => [row.ad_id, row]));
  const days = Array.from({ length: 14 }, (_, index) => accountDate(now, 14 - index));
  return {
    status: countedDaily.some((row) => row.spend > 0 && row.stat_date >= accountDate(now, 3)) ? "active" : "inactive",
    adCount: links.length,
    accounts: new Set(links.map((link) => link.advertiser_id)).size,
    lifetime: totals(counted), last7d: totals(window(7, 1)), prev7d: totals(window(14, 8)),
    daily: days.map((date) => {
      const rows = countedDaily.filter((row) => row.stat_date === date);
      return { date, spend: rows.reduce((sum, row) => sum + row.spend, 0), registrations: rows.reduce((sum, row) => sum + row.registrations, 0), installs: rows.reduce((sum, row) => sum + row.installs, 0) };
    }),
    topAds: links.filter((link) => byAd.has(link.ad_id))
      .map((link) => ({ adId: link.ad_id, adName: link.ad_name, campaignName: link.campaign_name, advertiserName: link.advertiser_name, ...totals([byAd.get(link.ad_id)!]) }))
      .sort((a, b) => b.spend - a.spend).slice(0, 10),
    refreshedAt: lifetime.reduce<string | null>((latest, row) => !latest || row.refreshed_at > latest ? row.refreshed_at : latest, null),
    currencyExcluded: lifetime.length - counted.length,
  };
}

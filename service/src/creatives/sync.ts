import type { ContentLabDatabase } from "../db/database.js";
import { TikTokApiError } from "../ads/parse.js";
import { TIKTOK_TOOLS, type PlannedCall } from "../ads/proxy.js";
import { withPage } from "../ads/plan.js";
import { putSyncEvent } from "../sync/outbox.js";

/** The windows the Site lets people switch between. */
export const CREATIVE_WINDOWS = [7, 14, 30] as const;
const METRICS = ["spend", "impressions", "clicks", "app_install", "registration"];
const BATCH = 100;
export const CREATIVE_MAX_CALLS = 160;

type Response = { code?: number; message?: string; data?: { list?: unknown[]; page_info?: { page?: number; total_page?: number } } };
function body(raw: unknown): NonNullable<Response["data"]> {
  const response = raw as Response;
  if (!response || typeof response !== "object") throw new Error("TikTok response is not an object");
  if (response.code !== 0) throw new TikTokApiError(Number(response.code ?? -1), String(response.message ?? "unknown"));
  return response.data ?? {};
}
const more = (page: { page?: number; total_page?: number } | undefined): boolean => (page?.page ?? 1) < (page?.total_page ?? 1);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null;
const number = (value: unknown): number => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };

export interface CountryRow { adId: string; country: string; spend: number; impressions: number; clicks: number; installs: number; registrations: number; currency: string | null }
export interface CreativeAd { adId: string; videoId: string | null; isSpark: boolean; adName: string | null; campaignName: string | null }
export interface VideoInfo { videoId: string; fileName: string | null; materialId: string | null; durationS: number | null; coverUrl: string | null; previewUrl: string | null }

export function parseCountryRows(raw: unknown): { rows: CountryRow[]; morePages: boolean } {
  const data = body(raw);
  const rows = (data.list ?? []).map((item) => {
    const { dimensions = {}, metrics = {} } = item as { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> };
    return {
      adId: String(dimensions.ad_id), country: String(dimensions.country_code ?? "—"),
      spend: number(metrics.spend), impressions: number(metrics.impressions), clicks: number(metrics.clicks),
      installs: number(metrics.app_install), registrations: number(metrics.registration), currency: text(metrics.currency),
    };
  });
  return { rows, morePages: more(data.page_info) };
}

export function parseCreativeAds(raw: unknown): { ads: CreativeAd[]; morePages: boolean } {
  const data = body(raw);
  const ads = (data.list ?? []).map((item) => {
    const row = item as Record<string, unknown>;
    // A Spark Ad promotes a published TikTok post; a regular ad carries an uploaded video of its own.
    return { adId: String(row.ad_id), videoId: text(row.video_id), isSpark: text(row.tiktok_item_id) !== null, adName: text(row.ad_name), campaignName: text(row.campaign_name) };
  });
  return { ads, morePages: more(data.page_info) };
}

export function parseVideoInfo(raw: unknown): VideoInfo[] {
  return (body(raw).list ?? []).map((item) => {
    const row = item as Record<string, unknown>;
    return { videoId: String(row.video_id), fileName: text(row.file_name), materialId: text(row.material_id), durationS: typeof row.duration === "number" ? row.duration : null, coverUrl: text(row.video_cover_url), previewUrl: text(row.preview_url) };
  });
}

const accountDate = (now: Date, minusDays = 0): string => new Date(now.getTime() + 8 * 3_600_000 - minusDays * 86_400_000).toISOString().slice(0, 10);

/** Spend by ad and country over the last `days` days up to yesterday (Taipei dates). */
export function countryReportCall(advertiserId: string, days: number, now: Date): PlannedCall {
  return {
    tool: TIKTOK_TOOLS.report,
    input: {
      // A one-item advertiser_ids list makes the API return the currency with every row.
      advertiser_ids: [advertiserId], report_type: "AUDIENCE", data_level: "AUCTION_AD", dimensions: ["ad_id", "country_code"], metrics: METRICS,
      start_date: accountDate(now, days), end_date: accountDate(now, 1), page: 1, page_size: 1000,
      filtering: [{ field_name: "ad_status", filter_type: "IN", filter_value: JSON.stringify(["STATUS_ALL"]) }],
    },
  };
}

export const adDetailsCall = (advertiserId: string, adIds: string[]): PlannedCall => ({
  tool: TIKTOK_TOOLS.execute,
  input: { tool_name: "ad_get", params: { advertiser_id: advertiserId, fields: ["ad_id", "ad_name", "campaign_name", "video_id", "tiktok_item_id"], filtering: { ad_ids: adIds, primary_status: "STATUS_ALL" }, page: 1, page_size: 1000, exclude_field_types_in_response: ["NULL_FIELD"] } },
});

export const videoInfoCall = (advertiserId: string, videoIds: string[]): PlannedCall => ({
  tool: TIKTOK_TOOLS.execute,
  input: { tool_name: "file_video_ad_info_get", params: { advertiser_id: advertiserId, video_ids: videoIds } },
});

const batches = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export interface CreativeSyncResult { status: "ok" | "partial" | "failed"; calls: number; accounts: number; creatives: number; error?: string }

/**
 * Regular (non-Spark) video ads with spend: which video each ad runs, the videos' details, and spend by country for the
 * last 7, 14 and 30 days, summed per video. Every call is planned here; the proxy runs only that call, read-only.
 */
export async function runCreativeSync(db: ContentLabDatabase, deps: { call: (call: PlannedCall) => Promise<unknown> }, now = new Date(), options: { maxCalls?: number } = {}): Promise<CreativeSyncResult> {
  const at = now.toISOString();
  let calls = 0;
  const request = async (call: PlannedCall): Promise<unknown> => {
    if (calls >= (options.maxCalls ?? CREATIVE_MAX_CALLS)) throw new Error("call budget exhausted");
    calls += 1;
    try { return await deps.call(call); } catch { calls += 1; return deps.call(call); }
  };
  const accounts = db.prepare("SELECT advertiser_id FROM ad_accounts ORDER BY advertiser_id").all() as Array<{ advertiser_id: string }>;
  const result: CreativeSyncResult = { status: "ok", calls: 0, accounts: accounts.length, creatives: 0 };
  // Per video, window and country; filled from every account, then written at once.
  const totals = new Map<string, { videoId: string; window: number; country: string; spend: number; impressions: number; clicks: number; installs: number; registrations: number }>();
  try {
    for (const { advertiser_id: advertiserId } of accounts) {
      const rowsByWindow = new Map<number, CountryRow[]>();
      for (const window of CREATIVE_WINDOWS) {
        const rows: CountryRow[] = [];
        for (let page = 1; ; page += 1) {
          const parsed = parseCountryRows(await request(withPage(countryReportCall(advertiserId, window, now), page)));
          // Only USD is summed; another currency would mix units.
          rows.push(...parsed.rows.filter((row) => row.spend > 0 && (row.currency === null || row.currency === "USD")));
          if (!parsed.morePages) break;
        }
        rowsByWindow.set(window, rows);
      }
      const adIds = [...new Set([...rowsByWindow.values()].flat().map((row) => row.adId))];
      const known = new Set((db.prepare("SELECT ad_id FROM creative_ads WHERE advertiser_id=?").all(advertiserId) as Array<{ ad_id: string }>).map((row) => row.ad_id));
      const saveAd = db.prepare(`INSERT INTO creative_ads(ad_id, advertiser_id, video_id, is_spark, ad_name, campaign_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ad_id) DO UPDATE SET video_id=excluded.video_id, is_spark=excluded.is_spark, ad_name=excluded.ad_name, campaign_name=excluded.campaign_name, updated_at=excluded.updated_at`);
      for (const batch of batches(adIds.filter((id) => !known.has(id)), BATCH)) {
        for (let page = 1; ; page += 1) {
          const parsed = parseCreativeAds(await request(withPage(adDetailsCall(advertiserId, batch), page)));
          for (const ad of parsed.ads) saveAd.run(ad.adId, advertiserId, ad.videoId, ad.isSpark ? 1 : 0, ad.adName, ad.campaignName, at);
          if (!parsed.morePages) break;
        }
      }
      const videoOf = new Map((db.prepare("SELECT ad_id, video_id FROM creative_ads WHERE advertiser_id=? AND is_spark=0 AND video_id IS NOT NULL").all(advertiserId) as Array<{ ad_id: string; video_id: string }>).map((row) => [row.ad_id, row.video_id]));
      for (const [window, rows] of rowsByWindow) {
        for (const row of rows) {
          const videoId = videoOf.get(row.adId);
          if (!videoId) continue;
          const key = `${videoId}|${window}|${row.country}`;
          const sum = totals.get(key) ?? { videoId, window, country: row.country, spend: 0, impressions: 0, clicks: 0, installs: 0, registrations: 0 };
          sum.spend += row.spend; sum.impressions += row.impressions; sum.clicks += row.clicks; sum.installs += row.installs; sum.registrations += row.registrations;
          totals.set(key, sum);
        }
      }
      // Details for videos seen for the first time, from the account that runs them.
      const videos = [...new Set([...totals.values()].map((item) => item.videoId))].filter((videoId) => [...videoOf.values()].includes(videoId) && !db.prepare("SELECT 1 FROM creatives WHERE video_id=?").get(videoId));
      const saveVideo = db.prepare(`INSERT OR IGNORE INTO creatives(video_id, advertiser_id, file_name, material_id, duration_s, cover_url, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const batch of batches(videos, 60)) {
        for (const info of parseVideoInfo(await request(videoInfoCall(advertiserId, batch)))) saveVideo.run(info.videoId, advertiserId, info.fileName, info.materialId, info.durationS, info.coverUrl, at, at);
      }
    }
    // Every account is read: the windows are replaced as a whole, so a video that stopped spending leaves them.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM creative_stats");
      const save = db.prepare("INSERT INTO creative_stats(video_id, window_days, country, spend, impressions, clicks, installs, registrations, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const item of totals.values()) save.run(item.videoId, item.window, item.country, item.spend, item.impressions, item.clicks, item.installs, item.registrations, at);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const videos = (db.prepare("SELECT DISTINCT video_id FROM creative_stats").all() as Array<{ video_id: string }>).map((row) => row.video_id);
    for (const videoId of videos) syncCreative(db, videoId, at);
    result.creatives = videos.length;
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.calls = calls;
  return result;
}

/** What the Site shows for one creative: details, analysis and spend by window and country. */
export function creativeReadModel(db: ContentLabDatabase, videoId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM creatives WHERE video_id=?").get(videoId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const stats = db.prepare("SELECT window_days, country, spend, impressions, clicks, installs, registrations FROM creative_stats WHERE video_id=? ORDER BY window_days, spend DESC").all(videoId) as Array<{ window_days: number; country: string; spend: number; impressions: number; clicks: number; installs: number; registrations: number }>;
  const ads = db.prepare("SELECT COUNT(*) AS ads, GROUP_CONCAT(DISTINCT campaign_name) AS campaigns FROM creative_ads WHERE video_id=? AND is_spark=0").get(videoId) as { ads: number; campaigns: string | null };
  const analysis = typeof row.analysis_json === "string" ? JSON.parse(row.analysis_json) as Record<string, unknown> : null;
  return {
    videoId, fileName: row.file_name, durationS: row.duration_s, coverUrl: row.cover_url, firstSeenAt: row.first_seen_at,
    ads: ads.ads, campaigns: (ads.campaigns ?? "").split(",").filter(Boolean).slice(0, 10),
    stats: stats.map((item) => ({ window: item.window_days, country: item.country, spend: item.spend, impressions: item.impressions, clicks: item.clicks, installs: item.installs, registrations: item.registrations })),
    summaryZh: row.summary_zh, analyzedAt: row.analyzed_at, analysis,
  };
}

export function syncCreative(db: ContentLabDatabase, videoId: string, now = new Date().toISOString()): void {
  const model = creativeReadModel(db, videoId);
  if (model) putSyncEvent(db, "creative", videoId, model, now);
}

/** Taipei 12:00, after the morning ads refresh: one creative sync a day. */
export function creativeSyncDue(now: Date): string | null {
  const local = new Date(now.getTime() + 8 * 3_600_000);
  return local.getUTCHours() >= 12 ? `creative_sync:${local.toISOString().slice(0, 10)}` : null;
}

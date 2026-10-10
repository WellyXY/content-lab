export interface AdLink { adId: string; itemId: string | null; adName: string | null; campaignId: string | null; campaignName: string | null; adgroupId: string | null; createTime: string | null; modifyTime: string | null }
export interface MetricRow { adId: string; date: string | null; spend: number; impressions: number; clicks: number; installs: number; registrations: number; videoPlays: number; currency: string | null; timezone: string | null }

type Response = { code?: number; message?: string; data?: { list?: unknown[]; page_info?: { page?: number; total_page?: number } } };

export class TikTokApiError extends Error {
  constructor(readonly code: number, message: string) { super(`TikTok API error ${code}: ${message}`); }
}

function data(raw: unknown): NonNullable<Response["data"]> {
  const response = raw as Response;
  if (!response || typeof response !== "object") throw new Error("TikTok response is not an object");
  if (response.code !== 0) throw new TikTokApiError(Number(response.code ?? -1), String(response.message ?? "unknown"));
  return response.data ?? {};
}
const more = (page: { page?: number; total_page?: number } | undefined): boolean => (page?.page ?? 1) < (page?.total_page ?? 1);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null;
/** TikTok returns metrics as strings, and "-" when there is nothing to report. */
const number = (value: unknown): number => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };

export const parseAccounts = (raw: unknown): Array<{ advertiserId: string; name: string }> =>
  (data(raw).list ?? []).map((item) => { const row = item as Record<string, unknown>; return { advertiserId: String(row.advertiser_id), name: String(row.advertiser_name ?? "") }; });

export function parseAdLinks(raw: unknown): { links: AdLink[]; morePages: boolean } {
  const body = data(raw);
  const links = (body.list ?? []).map((item) => {
    const row = item as Record<string, unknown>;
    return {
      adId: String(row.ad_id), itemId: text(row.tiktok_item_id), adName: text(row.ad_name), campaignId: text(row.campaign_id),
      campaignName: text(row.campaign_name), adgroupId: text(row.adgroup_id), createTime: text(row.create_time), modifyTime: text(row.modify_time),
    };
  });
  return { links, morePages: more(body.page_info) };
}

export function parseReportRows(raw: unknown): { rows: MetricRow[]; morePages: boolean } {
  const body = data(raw);
  const rows = (body.list ?? []).map((item) => {
    const { dimensions = {}, metrics = {} } = item as { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> };
    const day = text(dimensions.stat_time_day);
    return {
      adId: String(dimensions.ad_id), date: day ? day.slice(0, 10) : null,
      spend: number(metrics.spend), impressions: number(metrics.impressions), clicks: number(metrics.clicks),
      installs: number(metrics.app_install), registrations: number(metrics.registration), videoPlays: number(metrics.video_play_actions),
      currency: text(metrics.currency), timezone: text(metrics.timezone),
    };
  });
  return { rows, morePages: more(body.page_info) };
}

import { TIKTOK_TOOLS, type PlannedCall } from "./proxy.js";

export const METRICS = ["spend", "impressions", "clicks", "app_install", "registration", "video_play_actions"];
const AD_FIELDS = ["ad_id", "ad_name", "tiktok_item_id", "campaign_id", "campaign_name", "adgroup_id", "create_time", "modify_time"];
const BATCH = 100;
export const DAILY_DAYS = 14;

export const accountsCall = (): PlannedCall => ({ tool: TIKTOK_TOOLS.accounts, input: {} });

const apiTime = (iso: string): string => iso.slice(0, 19).replace("T", " ");

/** Ad listings for one account: a full scan (live plus deleted ads) the first time, then ads modified since the last scan, with a day of overlap. */
export function adLinkCalls(advertiserId: string, lastScanAt: string | null, page: number): PlannedCall[] {
  const call = (filtering?: Record<string, unknown>): PlannedCall => ({
    tool: TIKTOK_TOOLS.execute,
    input: { tool_name: "ad_get", params: { advertiser_id: advertiserId, fields: AD_FIELDS, page, page_size: 1000, exclude_field_types_in_response: ["NULL_FIELD"], ...(filtering ? { filtering } : {}) } },
  });
  if (!lastScanAt) return [call(), call({ primary_status: "STATUS_DELETE" })];
  return [call({ modified_after: apiTime(new Date(Date.parse(lastScanAt) - 86_400_000).toISOString()) })];
}

function report(advertiserId: string, adIds: string[], extra: Record<string, unknown>): PlannedCall {
  return {
    tool: TIKTOK_TOOLS.report,
    input: {
      // A one-item advertiser_ids list makes the API return currency and time zone with every row.
      advertiser_ids: [advertiserId], report_type: "BASIC", data_level: "AUCTION_AD", metrics: METRICS, page: 1, page_size: 1000,
      filtering: [
        { field_name: "ad_ids", filter_type: "IN", filter_value: JSON.stringify(adIds) },
        { field_name: "ad_status", filter_type: "IN", filter_value: JSON.stringify(["STATUS_ALL"]) },
      ],
      ...extra,
    },
  };
}

const batches = (ids: string[]): string[][] => Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, index) => ids.slice(index * BATCH, (index + 1) * BATCH));

export const lifetimeCalls = (advertiserId: string, adIds: string[]): PlannedCall[] =>
  batches(adIds).map((batch) => report(advertiserId, batch, { dimensions: ["ad_id"], query_lifetime: true }));

/** Daily rows for the last DAILY_DAYS days up to `endDate` (YYYY-MM-DD, the ad account's own dates). */
export function dailyCalls(advertiserId: string, adIds: string[], endDate: string): PlannedCall[] {
  const start = new Date(Date.parse(`${endDate}T00:00:00Z`) - (DAILY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  return batches(adIds).map((batch) => report(advertiserId, batch, { dimensions: ["ad_id", "stat_time_day"], start_date: start, end_date: endDate }));
}

/** The same call for another page. */
export function withPage(call: PlannedCall, page: number): PlannedCall {
  if (call.tool === TIKTOK_TOOLS.execute) {
    const input = call.input as { tool_name: string; params: Record<string, unknown> };
    return { tool: call.tool, input: { ...input, params: { ...input.params, page } } };
  }
  return { tool: call.tool, input: { ...call.input, page } };
}

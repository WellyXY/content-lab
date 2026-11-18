// Kept free of runtime imports so node:test can load it.

export type CreativeStat = { window: number; country: string; spend: number; impressions: number; clicks: number; installs: number; registrations: number };
export type Creative = {
  videoId: string; fileName: string | null; durationS: number | null; coverUrl: string | null; firstSeenAt: string;
  ads: number; campaigns: string[]; stats: CreativeStat[]; summaryZh: string | null; analyzedAt: string | null;
  analysis: { hook_translation_zh?: string; hook_text?: string; formula_zh?: string; summary_en?: string; keyframes?: string[] } | null;
};
export type CreativeTotals = { spend: number; impressions: number; clicks: number; installs: number; registrations: number; cpr: number | null; cpi: number | null; ctr: number | null };

/** One creative's totals for a window, over one country or all of them. */
export function creativeTotals(creative: Creative, window: number, country: string | null): CreativeTotals {
  const rows = creative.stats.filter((item) => item.window === window && (country === null || item.country === country));
  const sum = (key: "spend" | "impressions" | "clicks" | "installs" | "registrations") => rows.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const spend = sum("spend"); const impressions = sum("impressions"); const clicks = sum("clicks"); const installs = sum("installs"); const registrations = sum("registrations");
  return { spend, impressions, clicks, installs, registrations, cpr: registrations > 0 ? spend / registrations : null, cpi: installs > 0 ? spend / installs : null, ctr: impressions > 0 ? clicks / impressions : null };
}

/** Countries by total spend in a window, largest first. */
export function countriesBySpend(creatives: Creative[], window: number): Array<{ country: string; spend: number }> {
  const spend = new Map<string, number>();
  for (const creative of creatives) for (const item of creative.stats) if (item.window === window) spend.set(item.country, (spend.get(item.country) ?? 0) + (Number(item.spend) || 0));
  return [...spend].map(([country, total]) => ({ country, spend: total })).sort((a, b) => b.spend - a.spend);
}

export type CreativeSort = "spend" | "registrations" | "cpr";

/** The creatives with spend in the window (and country), sorted; cost sorts put creatives without registrations last. */
export function listCreatives(creatives: Creative[], window: number, country: string | null, sort: CreativeSort, query = ""): Array<{ creative: Creative; totals: CreativeTotals }> {
  const needle = query.trim().toLowerCase();
  return creatives
    .filter((creative) => !needle || (creative.fileName ?? "").toLowerCase().includes(needle) || creative.campaigns.some((name) => name.toLowerCase().includes(needle)))
    .map((creative) => ({ creative, totals: creativeTotals(creative, window, country) }))
    .filter((item) => item.totals.spend > 0)
    .sort((a, b) => sort === "registrations" ? b.totals.registrations - a.totals.registrations || b.totals.spend - a.totals.spend
      : sort === "cpr" ? (a.totals.cpr ?? Infinity) - (b.totals.cpr ?? Infinity) || b.totals.spend - a.totals.spend
      : b.totals.spend - a.totals.spend);
}

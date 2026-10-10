import type { PostAds } from "@/lib/content-lab";

// Kept free of runtime imports so node:test can load it.

/** $ with two decimals, truncated (not rounded), as the reports show money; missing data is a dash, never $0. */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const truncated = Math.trunc(value * 100 + 1e-9) / 100;
  return `$${truncated.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed percentage change from full-precision values; undefined without a positive prior value. */
export function formatPercentChange(current: number | null | undefined, prior: number | null | undefined): string | null {
  if (current === null || current === undefined || prior === null || prior === undefined || prior === 0) return null;
  const change = ((current - prior) / prior) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

export type AdsSortKey = "spend" | "registrations" | "cpr";

/** Larger sorts first. Unpromoted posts and missing costs go last; a cheaper registration cost ranks higher. */
export function adsSortValue(post: { ads?: Pick<PostAds, "lifetime"> | null }, key: AdsSortKey): number {
  const lifetime = post.ads?.lifetime;
  if (!lifetime) return Number.NEGATIVE_INFINITY;
  if (key === "cpr") return lifetime.cpr === null || lifetime.cpr === undefined ? Number.NEGATIVE_INFINITY : -lifetime.cpr;
  return lifetime[key] ?? Number.NEGATIVE_INFINITY;
}

const sum = (path: string, alias: string) => `SUM(json_extract(ads_json, '$.${path}')) AS ${alias}`;
/** Per-market delivery of tracked posts: sums only, so costs can be divided from the sums. */
export const marketAdsSql = `SELECT market, COUNT(*) AS promoted_posts, SUM(json_extract(ads_json, '$.status') = 'active') AS active_posts,
  ${sum("last7d.spend", "spend_7d")}, ${sum("last7d.registrations", "registrations_7d")}, ${sum("last7d.installs", "installs_7d")}, ${sum("last7d.impressions", "impressions_7d")},
  ${sum("prev7d.spend", "spend_prev_7d")}, ${sum("prev7d.registrations", "registrations_prev_7d")}, ${sum("prev7d.installs", "installs_prev_7d")}, ${sum("prev7d.impressions", "impressions_prev_7d")}
  FROM posts WHERE ads_json IS NOT NULL AND ads_json != 'null' GROUP BY market ORDER BY spend_7d DESC`;

export type WindowTotals = { spend: number; registrations: number; installs: number; impressions: number; cpr: number | null; cpi: number | null; cpm: number | null };
export type MarketAds = { market: string; promotedPosts: number; activePosts: number; last7d: WindowTotals; prev7d: WindowTotals };

const window = (spend: unknown, registrations: unknown, installs: unknown, impressions: unknown): WindowTotals => {
  const s = Number(spend ?? 0); const r = Number(registrations ?? 0); const i = Number(installs ?? 0); const m = Number(impressions ?? 0);
  return { spend: s, registrations: r, installs: i, impressions: m, cpr: r > 0 ? s / r : null, cpi: i > 0 ? s / i : null, cpm: m > 0 ? (s / m) * 1000 : null };
};

export function rowToMarketAds(row: Record<string, unknown>): MarketAds {
  return {
    market: String(row.market), promotedPosts: Number(row.promoted_posts ?? 0), activePosts: Number(row.active_posts ?? 0),
    last7d: window(row.spend_7d, row.registrations_7d, row.installs_7d, row.impressions_7d),
    prev7d: window(row.spend_prev_7d, row.registrations_prev_7d, row.installs_prev_7d, row.impressions_prev_7d),
  };
}

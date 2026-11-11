import type { ContentLabDatabase } from "../db/database.js";

/** A post worth telling the group about today, and why. */
export interface Standout {
  postId: string;
  sitePostId: string | null;
  url: string;
  handle: string | null;
  market: string | null;
  type: "video" | "photo";
  views: number | null;
  /** Views gained in the last 24 hours (captured hours only). */
  dayViews: number;
  /** Signals raised in the last 24 hours: surge, acceleration, milestone. */
  signals: string[];
  /** Yesterday's Spark Ads delivery (the ad account's date), when the post was promoted. */
  ads: { spend: number; registrations: number; costPerRegistration: number | null } | null;
  reasons: Array<"views" | "ads">;
}

const DAY = 86_400_000;
export const MAX_VIEW_STANDOUTS = 5;
export const MAX_ADS_STANDOUTS = 3;
export const MAX_PHOTO_EXTRAS = 2;
/** A promoted post stands out on ads with at least this many registrations and this much spend in one day. */
export const ADS_MIN_REGISTRATIONS = 30;
export const ADS_MIN_SPEND = 20;

/** Yesterday in Taipei (UTC+8), the day the morning update reports on. */
export function reportDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000 - DAY).toISOString().slice(0, 10);
}

/**
 * Today's standouts: posts that raised a views signal in the last 24 hours (most views gained first), and the
 * promoted posts with the most registrations yesterday. A post can be both.
 */
/** A post the group was told about this recently is not repeated, unless it has since passed a new views milestone. */
export const REPEAT_AFTER_DAYS = 3;

export function recentlyReported(db: ContentLabDatabase, now: Date): Set<string> {
  const since = new Date(now.getTime() + 8 * 3_600_000 - (REPEAT_AFTER_DAYS + 1) * DAY).toISOString().slice(0, 10);
  return new Set((db.prepare("SELECT DISTINCT post_id FROM digest_posts WHERE report_date >= ?").all(since) as Array<{ post_id: string }>).map((row) => row.post_id));
}

export function selectStandouts(db: ContentLabDatabase, now = new Date(), skip: ReadonlySet<string> = new Set()): Standout[] {
  const since = new Date(now.getTime() - DAY).toISOString();
  const date = reportDate(now);
  const signalRows = (db.prepare(`SELECT post_id, GROUP_CONCAT(DISTINCT rule) AS rules FROM alerts
    WHERE rule IN ('surge','acceleration','milestone') AND fired_at >= ? AND post_id IS NOT NULL GROUP BY post_id`).all(since) as Array<{ post_id: string; rules: string }>)
    .filter((row) => !skip.has(row.post_id) || row.rules.split(",").includes("milestone"));
  const adRows = db.prepare(`SELECT p.id AS post_id, SUM(d.spend) AS spend, SUM(d.registrations) AS registrations
    FROM ad_daily d JOIN ad_links l ON l.ad_id=d.ad_id JOIN posts p ON p.video_id=l.tiktok_item_id
    WHERE d.stat_date=? GROUP BY p.id`).all(date) as Array<{ post_id: string; spend: number; registrations: number }>;
  const ads = new Map(adRows.map((row) => [row.post_id, { spend: row.spend, registrations: row.registrations, costPerRegistration: row.registrations > 0 ? row.spend / row.registrations : null }]));
  const describe = (postId: string): Omit<Standout, "signals" | "reasons"> | null => {
    const post = db.prepare(`SELECT p.id, p.site_post_id, p.url, p.market, p.type, c.handle,
        (SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1) AS views,
        (SELECT COALESCE(SUM(views_delta), 0) FROM post_hourly h WHERE h.post_id=p.id AND h.hour_bucket >= ?) AS day_views
      FROM posts p LEFT JOIN creators c ON c.id=p.creator_id WHERE p.id=?`).get(since, postId) as { id: string; site_post_id: string | null; url: string; market: string | null; type: string | null; handle: string | null; views: number | null; day_views: number } | undefined;
    if (!post) return null;
    return { postId: post.id, sitePostId: post.site_post_id, url: post.url, handle: post.handle, market: post.market, type: post.type === "photo" ? "photo" : "video", views: post.views, dayViews: post.day_views, ads: ads.get(post.id) ?? null };
  };
  const byViews = signalRows.map((row) => ({ base: describe(row.post_id), signals: row.rules.split(",") })).filter((item): item is { base: NonNullable<ReturnType<typeof describe>>; signals: string[] } => item.base !== null)
    .sort((a, b) => b.base.dayViews - a.base.dayViews).slice(0, MAX_VIEW_STANDOUTS);
  const picked = new Map<string, Standout>(byViews.map((item) => [item.base.postId, { ...item.base, signals: item.signals, reasons: ["views"] }]));
  // Photo carousels can be copied the same day, so the best of them are listed even below the top videos.
  const photos = signalRows.filter((row) => !picked.has(row.post_id)).map((row) => ({ base: describe(row.post_id), signals: row.rules.split(",") }))
    .filter((item): item is { base: NonNullable<ReturnType<typeof describe>>; signals: string[] } => item.base?.type === "photo")
    .sort((a, b) => b.base.dayViews - a.base.dayViews).slice(0, MAX_PHOTO_EXTRAS);
  for (const item of photos) picked.set(item.base.postId, { ...item.base, signals: item.signals, reasons: ["views"] });
  const byAds = adRows.filter((row) => row.registrations >= ADS_MIN_REGISTRATIONS && row.spend >= ADS_MIN_SPEND && (!skip.has(row.post_id) || picked.has(row.post_id))).sort((a, b) => b.registrations - a.registrations).slice(0, MAX_ADS_STANDOUTS);
  for (const row of byAds) {
    const existing = picked.get(row.post_id);
    if (existing) { existing.reasons.push("ads"); continue; }
    const base = describe(row.post_id);
    if (base) picked.set(row.post_id, { ...base, signals: [], reasons: ["ads"] });
  }
  return [...picked.values()];
}

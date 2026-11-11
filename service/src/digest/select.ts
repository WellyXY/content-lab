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

/** Photo carousels copied by each daily update: half the cheapest registrations, half the fastest growth. */
export const DAILY_PHOTO_COPIES = 10;
/** A carousel's registration cost counts once its Spark Ads spent this much and brought this many registrations. */
export const COPY_MIN_SPEND = 50;
export const COPY_MIN_REGISTRATIONS = 30;

/** Why a carousel was picked for copying. */
export type CopyReason = "cheap_registrations" | "growth";
export interface PhotoPick extends Standout { pick: CopyReason[]; costPerRegistration: number | null }

/**
 * Today's carousels to copy, each copied once (one with a finished copy that has versions is skipped):
 * half the lowest lifetime cost per registration (with enough Spark Ads evidence), half the most views gained in the
 * last 24 hours; either side fills the other's unused places.
 */
export function topPhotoPosts(db: ContentLabDatabase, now = new Date(), limit = DAILY_PHOTO_COPIES): PhotoPick[] {
  const since = new Date(now.getTime() - DAY).toISOString();
  const rows = db.prepare(`SELECT p.id, p.site_post_id, p.url, p.market, c.handle,
      (SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1) AS views,
      (SELECT COALESCE(SUM(views_delta), 0) FROM post_hourly h WHERE h.post_id=p.id AND h.hour_bucket >= ?) AS day_views,
      json_extract(p.ads_json, '$.lifetime.spend') AS spend, json_extract(p.ads_json, '$.lifetime.registrations') AS registrations
    FROM posts p LEFT JOIN creators c ON c.id=p.creator_id
    WHERE p.type='photo' AND p.tracking_state != 'stopped'
      AND NOT EXISTS (SELECT 1 FROM recreations r WHERE r.post_id=p.id AND r.status='complete' AND r.notes_json LIKE '%"versions":[{%')`).all(since) as Array<{ id: string; site_post_id: string | null; url: string; market: string | null; handle: string | null; views: number | null; day_views: number; spend: number | null; registrations: number | null }>;
  const toPick = (row: (typeof rows)[number]): PhotoPick => ({
    postId: row.id, sitePostId: row.site_post_id, url: row.url, handle: row.handle, market: row.market, type: "photo",
    views: row.views, dayViews: row.day_views, signals: [], ads: null, reasons: ["views"], pick: [],
    costPerRegistration: row.spend !== null && row.registrations ? row.spend / row.registrations : null,
  });
  const cheap = rows.filter((row) => (row.spend ?? 0) >= COPY_MIN_SPEND && (row.registrations ?? 0) >= COPY_MIN_REGISTRATIONS)
    .map(toPick).sort((a, b) => a.costPerRegistration! - b.costPerRegistration!);
  const growth = rows.filter((row) => row.day_views > 0).map(toPick).sort((a, b) => b.dayViews - a.dayViews);
  const picked = new Map<string, PhotoPick>();
  const isCheap = new Set(cheap.map((post) => post.postId));
  // Half the places go to the cheapest registrations, the rest to growth; whichever side runs short, the other fills in.
  const cheapPlaces = Math.min(Math.ceil(limit / 2), cheap.length);
  for (const post of cheap.slice(0, cheapPlaces)) picked.set(post.postId, { ...post, pick: ["cheap_registrations"] });
  for (const post of growth) {
    if (picked.size >= limit) break;
    const existing = picked.get(post.postId);
    if (existing) existing.pick.push("growth"); else picked.set(post.postId, { ...post, pick: isCheap.has(post.postId) ? ["growth", "cheap_registrations"] : ["growth"] });
  }
  for (const post of cheap.slice(cheapPlaces)) {
    if (picked.size >= limit) break;
    if (!picked.has(post.postId)) picked.set(post.postId, { ...post, pick: ["cheap_registrations"] });
  }
  return [...picked.values()];
}

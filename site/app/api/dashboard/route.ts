import { createDemoDashboard, type DashboardData } from "@/lib/content-lab";
import { getD1, integer, rowToAlert, rowToPost } from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getD1();
    const [countResult, totalsResult, previousResult, jobsResult, captureResult, workerResult, trendResult, moversResult, alertsResult, marketsResult] = await db.batch([
      db.prepare("SELECT COUNT(*) AS count FROM posts"),
      db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN captured_at >= datetime('now', '-7 days') AND ok = 1 THEN MAX(views_delta, 0) ELSE 0 END), 0) AS views_7d,
        (SELECT COUNT(*) FROM posts WHERE tracking_state IN ('active', 'slow', 'daily')) AS active_posts,
        (SELECT COUNT(*) FROM posts WHERE views >= 1000000 AND COALESCE(published_at, bound_at) >= datetime('now', '-7 days')) AS million_posts
        FROM metric_snapshots`),
      db.prepare("SELECT COALESCE(SUM(MAX(views_delta, 0)), 0) AS views_previous_7d FROM metric_snapshots WHERE captured_at >= datetime('now', '-14 days') AND captured_at < datetime('now', '-7 days') AND ok = 1"),
      db.prepare("SELECT SUM(CASE WHEN status IN ('queued','retry') THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS running FROM jobs"),
      db.prepare("SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE 100.0 * SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) / COUNT(*) END AS rate FROM metric_snapshots WHERE captured_at >= datetime('now', '-1 day')"),
      db.prepare("SELECT id, last_seen_at, queue_depth FROM workers ORDER BY last_seen_at DESC LIMIT 1"),
      db.prepare(`SELECT substr(captured_at, 1, 13) || ':00:00.000Z' AS at, COALESCE(SUM(MAX(views_delta, 0)), 0) AS views
        FROM metric_snapshots WHERE captured_at >= datetime('now', '-7 days') AND ok = 1
        GROUP BY substr(captured_at, 1, 13) ORDER BY at ASC`),
      db.prepare("SELECT * FROM posts ORDER BY delta_24h DESC, views DESC LIMIT 5"),
      db.prepare("SELECT * FROM alerts ORDER BY fired_at DESC LIMIT 5"),
      db.prepare("SELECT market, COALESCE(SUM(delta_24h), 0) AS views, COUNT(*) AS posts FROM posts WHERE tracking_state != 'stopped' GROUP BY market ORDER BY views DESC"),
    ]);

    const worker = workerResult.results[0] as Record<string, unknown> | undefined;
    const lastSeenAt = typeof worker?.last_seen_at === "string" ? worker.last_seen_at : null;
    const workerConnected = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() < 480_000 : false;
    const workerStatus = { connected: workerConnected, lastSeenAt, queueDepth: integer(worker?.queue_depth) };
    const count = integer((countResult.results[0] as Record<string, unknown> | undefined)?.count);
    if (count === 0) {
      return Response.json({ ...createDemoDashboard(), worker: workerStatus }, { headers: { "cache-control": "no-store" } });
    }

    const totals = (totalsResult.results[0] ?? {}) as Record<string, unknown>;
    const previous = (previousResult.results[0] ?? {}) as Record<string, unknown>;
    const jobs = (jobsResult.results[0] ?? {}) as Record<string, unknown>;
    const capture = (captureResult.results[0] ?? {}) as Record<string, unknown>;

    const response: DashboardData = {
      mode: "live",
      generatedAt: new Date().toISOString(),
      worker: workerStatus,
      totals: {
        views7d: integer(totals.views_7d),
        viewsPrevious7d: integer(previous.views_previous_7d),
        activePosts: integer(totals.active_posts),
        millionPostsThisWeek: integer(totals.million_posts),
        queuedJobs: integer(jobs.queued),
        runningJobs: integer(jobs.running),
        captureSuccessRate24h: capture.rate == null ? null : Number(capture.rate),
      },
      trend: trendResult.results.map((row) => ({ at: String((row as Record<string, unknown>).at), views: integer((row as Record<string, unknown>).views) })),
      movers: moversResult.results.map((row) => rowToPost(row as Record<string, unknown>)),
      recentAlerts: alertsResult.results.map((row) => rowToAlert(row as Record<string, unknown>)),
      marketBreakdown: marketsResult.results.map((row) => ({ market: String((row as Record<string, unknown>).market), views: integer((row as Record<string, unknown>).views), posts: integer((row as Record<string, unknown>).posts) })),
    };
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("dashboard read failed", error);
    return Response.json(createDemoDashboard(), { headers: { "cache-control": "no-store" } });
  }
}

import type { ContentLabDatabase } from "../db/database.js";
import { normalizeTikTokUrl } from "../domain/tiktok-url.js";

type QueryCommand =
  | { kind: "help" }
  | { kind: "overview" }
  | { kind: "health" }
  | { kind: "top"; limit: number; market: string | null }
  | { kind: "alerts"; limit: number }
  | { kind: "jobs" }
  | { kind: "post"; key: string; keyType: "url" | "id" }
  | { kind: "unknown" };

const compact = (value: number): string => new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
}).format(value);

const oneLine = (value: unknown, limit = 120): string => String(value ?? "")
  .replace(/[\r\n\t]+/g, " ")
  .replace(/\s{2,}/g, " ")
  .trim()
  .slice(0, limit);

const countFrom = (input: string, fallback: number): number => {
  const match = input.match(/(?:top|前|最近)\s*(\d{1,2})\b/i)
    ?? input.match(/\b(\d{1,2})\s*(?:筆|笔|條|条|個|个)\b/i);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : fallback;
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : fallback, 10));
};

const marketFrom = (input: string): string | null => {
  const match = input.match(/(?:market|市場|市场)\s*[:=：]?\s*([A-Za-z0-9_-]{2,16})\b/i);
  return match?.[1]?.toUpperCase() ?? null;
};

export function parseContentLabQuery(raw: string): QueryCommand {
  const input = raw.normalize("NFKC").trim();
  if (!input) return { kind: "help" };
  const lower = input.toLowerCase();

  const urlMatch = input.match(/https:\/\/[^\s<>"']+/i);
  if (urlMatch?.[0]) {
    try {
      return { kind: "post", key: normalizeTikTokUrl(urlMatch[0].replace(/[),.;!?，。；！？]+$/, "")), keyType: "url" };
    } catch {
      return { kind: "unknown" };
    }
  }

  const postMatch = input.match(/(?:post|影片|視頻|视频|素材)\s*[:#=：]?\s*([A-Za-z0-9_-]{5,128})\b/i);
  if (postMatch?.[1]) return { kind: "post", key: postMatch[1], keyType: "id" };

  if (/(?:告警|警報|警报|報警|报警|alerts?|提醒)/i.test(lower)) {
    return { kind: "alerts", limit: countFrom(input, 5) };
  }
  if (/(?:熱門|热门|漲最快|涨最快|增長|增长|top\b|movers?|24h)/i.test(lower)) {
    return { kind: "top", limit: countFrom(input, 5), market: marketFrom(input) };
  }
  if (/(?:任務|任务|隊列|队列|jobs?|queue)/i.test(lower)) return { kind: "jobs" };
  if (/(?:健康|服務狀態|服务状态|worker|health)/i.test(lower)) return { kind: "health" };
  if (/(?:概覽|概览|總覽|总览|儀表板|仪表板|overview|summary|整體|整体)/i.test(lower)) return { kind: "overview" };
  if (/(?:幫助|帮助|指令|命令|怎麼用|怎么用|可查|help|commands?)/i.test(lower)) return { kind: "help" };
  return { kind: "unknown" };
}

const helpText = (unknown = false): string => [
  unknown ? "我沒辨識出這個唯讀查詢。" : "Content Lab 唯讀查詢：",
  "• 概覽",
  "• 熱門 5（可加：市場 VN）",
  "• 告警 5",
  "• 任務",
  "• 素材 <TikTok URL、video id 或 post id>",
  "• 健康",
  "群聊請 @ Bot；查詢不會執行 shell、寫入或重試任務。",
].join("\n");

function overview(db: ContentLabDatabase, nowMs: number): string {
  const currentStart = new Date(nowMs - 7 * 86_400_000).toISOString();
  const previousStart = new Date(nowMs - 14 * 86_400_000).toISOString();
  const dayStart = new Date(nowMs - 24 * 3_600_000).toISOString();
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN hour_bucket >= ? THEN views_delta END), 0) AS current,
      COALESCE(SUM(CASE WHEN hour_bucket >= ? AND hour_bucket < ? THEN views_delta END), 0) AS previous
    FROM post_hourly WHERE views_delta IS NOT NULL
  `).get(currentStart, previousStart, currentStart) as { current: number; previous: number };
  const status = db.prepare(`
    SELECT
      SUM(CASE WHEN tracking_state != 'stopped' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN features_state = 'features_failed' THEN 1 ELSE 0 END) AS features_failed
    FROM posts
  `).get() as { active: number | null; features_failed: number | null };
  const queue = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued','running','failed') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
    FROM jobs
  `).get() as { pending: number | null; dead: number | null };
  const alerts = db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE delivered_at IS NULL")
    .get() as { count: number };
  const mover = db.prepare(`
    SELECT p.video_id AS videoId, c.handle AS creator, COALESCE(SUM(h.views_delta), 0) AS delta
    FROM posts p
    LEFT JOIN creators c ON c.id = p.creator_id
    JOIN post_hourly h ON h.post_id = p.id AND h.hour_bucket >= ?
    GROUP BY p.id ORDER BY delta DESC LIMIT 1
  `).get(dayStart) as { videoId: string; creator: string | null; delta: number } | undefined;
  const change = totals.previous > 0 ? `${((totals.current - totals.previous) / totals.previous * 100).toFixed(1)}%` : "無前期基準";
  return [
    "Content Lab 概覽",
    `7 日播放增量：${compact(totals.current)}（較前 7 日 ${change}）`,
    `追蹤中素材：${status.active ?? 0}`,
    `待處理任務：${queue.pending ?? 0}；dead：${queue.dead ?? 0}`,
    `分析失敗：${status.features_failed ?? 0}；未送達告警：${alerts.count}`,
    mover ? `24h 領先：@${oneLine(mover.creator || "unknown", 40)} / ${mover.videoId}（+${compact(mover.delta)}）` : "24h 領先：暫無資料",
  ].join("\n");
}

function topPosts(db: ContentLabDatabase, command: Extract<QueryCommand, { kind: "top" }>, nowMs: number): string {
  const dayStart = new Date(nowMs - 24 * 3_600_000).toISOString();
  const rows = db.prepare(`
    SELECT p.video_id AS videoId, p.url, p.market, p.caption, c.handle AS creator,
           COALESCE((SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1), 0) AS views,
           COALESCE(SUM(h.views_delta), 0) AS delta
    FROM posts p
    LEFT JOIN creators c ON c.id=p.creator_id
    LEFT JOIN post_hourly h ON h.post_id=p.id AND h.hour_bucket >= ?
    WHERE (? IS NULL OR p.market = ?)
    GROUP BY p.id ORDER BY delta DESC LIMIT ?
  `).all(dayStart, command.market, command.market, command.limit) as Array<{
    videoId: string; url: string; market: string | null; caption: string | null; creator: string | null; views: number; delta: number;
  }>;
  if (rows.length === 0) return `24h 熱門${command.market ? `（市場 ${command.market}）` : ""}：暫無資料。`;
  return [
    `24h 熱門${command.market ? `（市場 ${command.market}）` : ""}`,
    ...rows.map((row, index) => [
      `${index + 1}. @${oneLine(row.creator || "unknown", 40)} · +${compact(row.delta)} · 累計 ${compact(row.views)}`,
      `${oneLine(row.caption || row.videoId, 80)}${row.market ? ` · ${oneLine(row.market, 16)}` : ""}`,
      row.url,
    ].join("\n")),
  ].join("\n");
}

function recentAlerts(db: ContentLabDatabase, limit: number): string {
  const rows = db.prepare(`
    SELECT a.rule, a.fired_at AS firedAt, a.payload_json AS payloadJson, p.video_id AS videoId
    FROM alerts a LEFT JOIN posts p ON p.id=a.post_id
    ORDER BY a.fired_at DESC LIMIT ?
  `).all(limit) as Array<{ rule: string; firedAt: string; payloadJson: string; videoId: string | null }>;
  if (rows.length === 0) return "最近告警：暫無資料。";
  return ["最近告警", ...rows.map((row, index) => {
    let detail = "";
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      if (typeof payload.error === "string") detail = " · 處理失敗，請查看本機日誌";
      else if (typeof payload.currentViews === "number") detail = ` · ${compact(payload.currentViews)} views`;
    } catch { /* keep malformed historic payloads from breaking the query */ }
    return `${index + 1}. ${oneLine(row.rule, 40)} · ${row.videoId ?? "系統"} · ${row.firedAt}${detail}`;
  })].join("\n");
}

function jobStatus(db: ContentLabDatabase): string {
  const rows = db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; count: number }>;
  const recent = db.prepare(`
    SELECT kind, status, updated_at AS updatedAt
    FROM jobs WHERE status IN ('failed','dead') ORDER BY updated_at DESC LIMIT 3
  `).all() as Array<{ kind: string; status: string; updatedAt: string }>;
  return [
    "任務狀態",
    rows.length > 0 ? rows.map((row) => `${row.status}: ${row.count}`).join(" · ") : "目前沒有任務",
    ...recent.map((row) => `${row.status}/${row.kind} · ${row.updatedAt}`),
  ].join("\n");
}

function health(db: ContentLabDatabase): string {
  const migration = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  const lastScan = db.prepare("SELECT value FROM scheduler_state WHERE key='last_scan_at'").get() as { value: string } | undefined;
  const latest = db.prepare("SELECT MAX(captured_at) AS value FROM metric_snapshots WHERE ok=1").get() as { value: string | null };
  const queue = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued','running','failed') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead
    FROM jobs
  `).get() as { pending: number | null; dead: number | null };
  return [
    "Content Lab 健康狀態",
    `SQLite：ok（schema ${migration.version ?? "—"}）`,
    `Worker 上次掃描：${lastScan?.value ?? "尚無"}`,
    `最新有效快照：${latest.value ?? "尚無"}`,
    `Queue：pending ${queue.pending ?? 0} · dead ${queue.dead ?? 0}`,
  ].join("\n");
}

function postDetail(db: ContentLabDatabase, command: Extract<QueryCommand, { kind: "post" }>, nowMs: number): string {
  const dayStart = new Date(nowMs - 24 * 3_600_000).toISOString();
  const byUrl = command.keyType === "url";
  const row = db.prepare(`
    SELECT p.id, p.video_id AS videoId, p.site_post_id AS sitePostId, p.url, p.market,
           p.project_tag AS projectTag, p.caption, p.tracking_state AS trackingState,
           p.features_state AS featuresState, p.bound_at AS boundAt, c.handle AS creator,
           COALESCE((SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1), 0) AS views,
           COALESCE((SELECT likes FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1), 0) AS likes,
           COALESCE((SELECT SUM(views_delta) FROM post_hourly h WHERE h.post_id=p.id AND h.hour_bucket >= ?), 0) AS delta24h
    FROM posts p LEFT JOIN creators c ON c.id=p.creator_id
    WHERE ${byUrl ? "p.url=?" : "(p.id=? OR p.video_id=? OR p.site_post_id=?)"}
    LIMIT 1
  `).get(dayStart, ...(byUrl ? [command.key] : [command.key, command.key, command.key])) as {
    id: string; videoId: string; sitePostId: string | null; url: string; market: string | null; projectTag: string | null;
    caption: string | null; trackingState: string; featuresState: string; boundAt: string; creator: string | null;
    views: number; likes: number; delta24h: number;
  } | undefined;
  if (!row) return "找不到這筆素材。請貼完整 TikTok URL、video id 或 post id。";
  return [
    `素材 ${row.videoId}`,
    `作者：@${oneLine(row.creator || "unknown", 40)}${row.market ? ` · 市場 ${oneLine(row.market, 16)}` : ""}`,
    `播放：${compact(row.views)} · 24h +${compact(row.delta24h)} · 讚 ${compact(row.likes)}`,
    `追蹤：${row.trackingState} · 分析：${row.featuresState}`,
    row.projectTag ? `專案：${oneLine(row.projectTag, 60)}` : null,
    row.caption ? `文案：${oneLine(row.caption, 160)}` : null,
    row.url,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function answerContentLabQuery(db: ContentLabDatabase, raw: string, now = new Date()): string {
  const command = parseContentLabQuery(raw.slice(0, 2_001));
  if (["overview", "top", "alerts", "jobs", "post"].includes(command.kind)) {
    const count = (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM posts) +
        (SELECT COUNT(*) FROM alerts) +
        (SELECT COUNT(*) FROM jobs) AS count
    `).get() as { count: number }).count;
    if (count === 0) return "Content Lab 尚無真實資料。";
  }
  switch (command.kind) {
    case "help": return helpText();
    case "unknown": return helpText(true);
    case "overview": return overview(db, now.getTime());
    case "health": return health(db);
    case "top": return topPosts(db, command, now.getTime());
    case "alerts": return recentAlerts(db, command.limit);
    case "jobs": return jobStatus(db);
    case "post": return postDetail(db, command, now.getTime());
  }
}

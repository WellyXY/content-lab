import { z } from "zod";

import { MARKET_CODES } from "@/lib/content-lab";

import {
  getD1,
  hashIdentifier,
  integer,
  jsonError,
  normalizeTikTokUrl,
  requestIp,
  rowToPost,
  runtimeEnv,
} from "@/lib/server/content-db";

export const dynamic = "force-dynamic";

const bindSchema = z.object({
  urls: z.array(z.string().min(1).max(2_048)).min(1).max(50),
  market: z.enum(MARKET_CODES).default("VN"),
  projectTag: z.string().trim().max(80).optional().nullable(),
  passphrase: z.string().max(200).optional(),
}).strict();

const sortColumns: Record<string, string> = {
  publishedAt: "julianday(p.published_at) DESC, p.id ASC",
  delta24h: "p.delta_24h DESC",
  views: "p.views DESC",
  newest: "p.bound_at DESC",
  potential: "CASE pred.band WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC, p.views DESC",
};

export async function GET(request: Request) {
  try {
    const db = getD1();
    const url = new URL(request.url);
    const market = url.searchParams.get("market")?.trim().toUpperCase();
    const state = url.searchParams.get("state")?.trim();
    const query = url.searchParams.get("q")?.trim();
    const sort = sortColumns[url.searchParams.get("sort") ?? "publishedAt"] ?? sortColumns.publishedAt;
    const limit = Math.min(200, Math.max(1, integer(url.searchParams.get("limit"), 100)));

    const filters: string[] = [];
    const values: unknown[] = [];
    if (market && market !== "ALL") { filters.push("p.market = ?"); values.push(market); }
    if (state && state !== "all") { filters.push("p.tracking_state = ?"); values.push(state); }
    if (query) {
      filters.push("(p.creator_handle LIKE ? OR p.caption LIKE ? OR p.project_tag LIKE ?)");
      const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      values.push(pattern, pattern, pattern);
    }

    const sql = `SELECT p.*,
      pred.rank_position, pred.rank_total, pred.band AS potential_band,
      json_extract(f.tags_json, '$.hook_type.value') AS hook_type,
      json_extract(f.tags_json, '$.topic.value') AS topic
      FROM posts p
      LEFT JOIN post_features f ON f.post_id = p.id
      LEFT JOIN predictions pred ON pred.id = (SELECT id FROM predictions WHERE post_id = p.id ORDER BY made_at DESC LIMIT 1)
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY ${sort} LIMIT ?`;
    const result = await db.prepare(sql).bind(...values, limit).all();
    return Response.json({ mode: "live", posts: result.results.map((row) => rowToPost(row as Record<string, unknown>)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("posts read failed", error);
    return jsonError("暂时无法读取帖子，请稍后重试 · Could not load posts; try again later", 503);
  }
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 120_000) return jsonError("请求太大 · Request too large", 413);
  let parsed: z.infer<typeof bindSchema>;
  try {
    parsed = bindSchema.parse(await request.json());
  } catch (error) {
    return jsonError("绑定数据格式不正确 · Invalid bind request", 400, error instanceof z.ZodError ? error.flatten() : undefined);
  }

  const requiredPassphrase = typeof runtimeEnv().BIND_PASSPHRASE === "string" ? runtimeEnv().BIND_PASSPHRASE : process.env.BIND_PASSPHRASE;
  if (requiredPassphrase && parsed.passphrase !== requiredPassphrase) return jsonError("绑定口令不正确 · Wrong bind passphrase", 403);

  const invalid: Array<{ input: string; error: string }> = [];
  const normalized = new Map<string, { url: string; videoId: string | null }>();
  for (const input of parsed.urls) {
    try {
      const item = normalizeTikTokUrl(input);
      normalized.set(item.url, item);
    } catch (error) {
      invalid.push({ input, error: error instanceof Error ? error.message : "链接不正确 · Invalid link" });
    }
  }
  if (!normalized.size) return jsonError("没有可绑定的 TikTok 链接 · No bindable TikTok links", 400, invalid);

  try {
    const db = getD1();
    const now = new Date();
    const nowIso = now.toISOString();
    const hourEnd = new Date(now.getTime() + 3_600_000);
    hourEnd.setUTCMinutes(0, 0, 0);
    const ipKey = `bind:${await hashIdentifier(requestIp(request))}:${nowIso.slice(0, 13)}`;

    const urls = [...normalized.keys()];
    const placeholders = urls.map(() => "?").join(",");
    const videoIds = [...normalized.values()].flatMap((item) => item.videoId ? [item.videoId] : []);
    const idClause = videoIds.length ? ` OR video_id IN (${videoIds.map(() => "?").join(",")})` : "";
    const [existingResult, rateResult, activeResult, dailyResult] = await db.batch([
      db.prepare(`SELECT url, video_id FROM posts WHERE url IN (${placeholders})${idClause}`).bind(...urls, ...videoIds),
      db.prepare("SELECT count FROM ingest_rate_limits WHERE key = ? AND expires_at > ?").bind(ipKey, nowIso),
      db.prepare("SELECT COUNT(*) AS count FROM posts WHERE tracking_state != 'stopped'"),
      db.prepare("SELECT COUNT(*) AS count FROM posts WHERE bound_at >= datetime('now', '-1 day')"),
    ]);
    const existing = new Set(existingResult.results.map((row) => String((row as Record<string, unknown>).url)));
    const existingIds = new Set(existingResult.results.map((row) => String((row as Record<string, unknown>).video_id)));
    for (const [itemUrl, item] of normalized) {
      if (item.videoId && existingIds.has(item.videoId)) existing.add(itemUrl);
    }
    const fresh = urls.filter((item) => !existing.has(item));
    const currentRate = integer((rateResult.results[0] as Record<string, unknown> | undefined)?.count);
    if (currentRate + fresh.length > 300) return jsonError("此网络每小时最多绑定 300 条帖子 · This network can bind at most 300 posts per hour", 429);
    if (integer((activeResult.results[0] as Record<string, unknown> | undefined)?.count) + fresh.length > 1_000) return jsonError("活跃追踪已达 1,000 条上限 · The 1,000 active post limit is reached", 409);
    if (integer((dailyResult.results[0] as Record<string, unknown> | undefined)?.count) + fresh.length > 300) return jsonError("今日新增已达 300 条上限 · Daily limit of 300 new posts reached", 429);

    const accepted: Array<{ id: string; url: string }> = [];
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO ingest_rate_limits (key, count, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`).bind(ipKey, currentRate + fresh.length, hourEnd.toISOString()),
    ];
    for (const itemUrl of fresh) {
      const item = normalized.get(itemUrl)!;
      const postId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const payload = {
        urls: [item.url],
        sitePostId: postId,
        market: parsed.market.toUpperCase(),
        projectTag: parsed.projectTag || null,
        boundBy: "gpt-site",
      };
      accepted.push({ id: postId, url: item.url });
      statements.push(
        db.prepare(`INSERT INTO posts (
          id, video_id, url, market, project_tag, bound_at, tracking_state, analysis_state, next_capture_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'queued', ?, ?)`).bind(
          postId, item.videoId, item.url, parsed.market.toUpperCase(), parsed.projectTag || null, nowIso, nowIso, nowIso,
        ),
        db.prepare(`INSERT INTO jobs (id, kind, payload_json, status, run_at, attempts, created_at, updated_at)
          VALUES (?, 'bind', ?, 'queued', ?, 0, ?, ?)`).bind(jobId, JSON.stringify(payload), nowIso, nowIso, nowIso),
      );
    }
    await db.batch(statements);
    return Response.json({ accepted, duplicates: urls.filter((item) => existing.has(item)), invalid }, { status: accepted.length ? 202 : 200 });
  } catch (error) {
    console.error("post binding failed", error);
    return jsonError("暂时无法加入处理队列，请稍后再试 · Could not queue the posts; try again later", 503);
  }
}

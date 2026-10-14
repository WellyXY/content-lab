// Kept free of runtime imports so node:test can load it.

export type NotificationKind = "signal" | "recreation_done" | "recreation_failed" | "new_posts" | "analysis_done";
export interface NotificationItem { id: string; kind: NotificationKind; at: string; href: string; titleZh: string; titleEn: string; detailZh: string; detailEn: string }

type AlertRow = { id: string; post_id: string | null; rule: string; fired_at: string; payload_json: string | null };
type RecreationRow = { id: string; post_id: string; status: string; updated_at: string; creator_handle: string | null };
type PostRow = { id: string; bound_at: string; market: string; creator_handle: string | null };
type AnalysisRow = { post_id: string; created_at: string; creator_handle: string | null };

const RULES: Array<[string, string, string]> = [["surge", "日增爆发", "daily surge"], ["acceleration", "加速", "accelerating"], ["milestone", "里程碑", "milestone"]];
const compact = (value: number): string => value >= 1e6 ? `${(value / 1e6).toFixed(2).replace(/\.?0+$/, "")}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(value);
const latest = (values: string[]): string => values.reduce((a, b) => (b > a ? b : a));
/** Events within the same ten minutes (a bind batch, an analysis run) read as one notification. */
const window = (at: string): string => at.slice(0, 15);
const groupBy = <T>(rows: T[], key: (row: T) => string): T[][] => [...rows.reduce((map, row) => map.set(key(row), [...(map.get(key(row)) ?? []), row]), new Map<string, T[]>()).values()];
const name = (handle: string | null, zh: boolean): string => handle ? `@${handle}` : zh ? "一条帖子" : "a post";

export function buildNotifications(input: { alerts: AlertRow[]; recreations: RecreationRow[]; posts: PostRow[]; analyses: AnalysisRow[] }, limit = 40): NotificationItem[] {
  const items: NotificationItem[] = [];
  // Signals that fire on one capture (surge, acceleration and milestone together) are one notification.
  for (const group of groupBy(input.alerts.filter((row) => row.post_id), (row) => `${row.post_id}|${row.fired_at.slice(0, 16)}`)) {
    const first = group[0]!;
    const payload = JSON.parse(first.payload_json ?? "{}") as { creatorHandle?: string | null; currentViews?: number };
    const rules = RULES.filter(([rule]) => group.some((row) => row.rule === rule));
    const views = typeof payload.currentViews === "number" ? payload.currentViews : null;
    items.push({
      id: `signal:${first.id}`, kind: "signal", at: latest(group.map((row) => row.fired_at)), href: `/posts/${first.post_id}`,
      titleZh: `${name(payload.creatorHandle ?? null, true)} 有新信号`, titleEn: `New signal on ${name(payload.creatorHandle ?? null, false)}`,
      detailZh: `${rules.map(([, zh]) => zh).join("、")}${views !== null ? ` · 目前 ${compact(views)} 播放` : ""}`,
      detailEn: `${rules.map(([, , en]) => en).join(", ")}${views !== null ? ` · ${compact(views)} views now` : ""}`,
    });
  }
  for (const row of input.recreations) {
    if (row.status !== "complete" && row.status !== "failed") continue;
    const done = row.status === "complete";
    items.push({
      id: `recreation:${row.id}`, kind: done ? "recreation_done" : "recreation_failed", at: row.updated_at, href: `/posts/${row.post_id}`,
      titleZh: done ? "Agent 重制完成" : "Agent 重制失败", titleEn: done ? "Agent recreation is ready" : "Agent recreation failed",
      detailZh: done ? `${name(row.creator_handle, true)} 的重制版本可以播放和下载了` : `${name(row.creator_handle, true)} 的重制没有完成`,
      detailEn: done ? `The recreation of ${name(row.creator_handle, false)} can be played and downloaded` : `The recreation of ${name(row.creator_handle, false)} did not finish`,
    });
  }
  for (const group of groupBy(input.posts, (row) => window(row.bound_at))) {
    const at = latest(group.map((row) => row.bound_at));
    if (group.length === 1) {
      const post = group[0]!;
      items.push({ id: `posts:${post.id}`, kind: "new_posts", at, href: `/posts/${post.id}`, titleZh: `新增帖子 ${name(post.creator_handle, true)}`, titleEn: `New post ${name(post.creator_handle, false)}`, detailZh: `${post.market} · 已开始追踪`, detailEn: `${post.market} · now tracked` });
      continue;
    }
    const markets = [...group.reduce((map, row) => map.set(row.market, (map.get(row.market) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    items.push({
      id: `posts:${group[0]!.id}`, kind: "new_posts", at, href: "/posts",
      titleZh: `新增 ${group.length} 条帖子`, titleEn: `${group.length} new posts`,
      detailZh: markets.map(([market, count]) => `${market} ${count}`).join("、"), detailEn: markets.map(([market, count]) => `${market} ${count}`).join(", "),
    });
  }
  for (const group of groupBy(input.analyses, (row) => window(row.created_at))) {
    const at = latest(group.map((row) => row.created_at));
    const single = group.length === 1 ? group[0]! : null;
    items.push({
      id: `analysis:${group[0]!.post_id}:${at}`, kind: "analysis_done", at, href: single ? `/posts/${single.post_id}` : "/posts",
      titleZh: single ? `${name(single.creator_handle, true)} 分析完成` : `${group.length} 条帖子分析完成`,
      titleEn: single ? `${name(single.creator_handle, false)} analyzed` : `${group.length} posts analyzed`,
      detailZh: "标签、脚本和评估已更新", detailEn: "Tags, script and assessment are ready",
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Items newer than the last time this viewer opened the list. */
export const unreadCount = (items: ReadonlyArray<{ at: string }>, lastSeen: string | null): number => lastSeen ? items.filter((item) => item.at > lastSeen).length : items.length;

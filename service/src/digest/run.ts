import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ImageCopyNotes } from "../copy/run.js";
import type { ContentLabDatabase } from "../db/database.js";
import type { DocItem, DocWriter } from "./doc.js";
import { DAILY_PHOTO_COPIES, recentlyReported, reportDate, selectStandouts, topPhotoPosts, type CopyReason, type Standout } from "./select.js";

/** A copied carousel as listed in the update (its numbers as of now). */
function describePhoto(db: ContentLabDatabase, postId: string, now: Date): Standout | null {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const row = db.prepare(`SELECT p.id, p.site_post_id, p.url, p.market, c.handle,
      (SELECT views FROM metric_snapshots s WHERE s.post_id=p.id AND s.ok=1 ORDER BY captured_at DESC LIMIT 1) AS views,
      (SELECT COALESCE(SUM(views_delta), 0) FROM post_hourly h WHERE h.post_id=p.id AND h.hour_bucket >= ?) AS day_views
    FROM posts p LEFT JOIN creators c ON c.id=p.creator_id WHERE p.id=?`).get(since, postId) as { id: string; site_post_id: string | null; url: string; market: string | null; handle: string | null; views: number | null; day_views: number } | undefined;
  return row ? { postId: row.id, sitePostId: row.site_post_id, url: row.url, handle: row.handle, market: row.market, type: "photo", views: row.views, dayViews: row.day_views, signals: [], ads: null, reasons: ["views"] } : null;
}
const SIGNALS: Record<string, string> = { surge: "日增爆发", acceleration: "加速", milestone: "里程碑" };

/** Taipei 11:00, after the morning sheet sync (09:30) and ads refresh (10:30). */
export function digestDue(now: Date): string | null {
  const local = new Date(now.getTime() + 8 * 3_600_000);
  return local.getUTCHours() >= 11 ? `daily_digest:${local.toISOString().slice(0, 10)}` : null;
}

const count = (value: number): string => Math.round(value).toLocaleString("en-US");
/** $ and two decimals, truncated; missing is a dash, never zero. */
export const money = (value: number | null): string => value === null || !Number.isFinite(value) ? "—" : `$${(Math.trunc(value * 100 + 1e-9) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (post: Standout): string => `${post.handle ? `@${post.handle}` : post.postId.slice(0, 8)}（${post.market ?? "—"} ${post.type === "photo" ? "图文" : "视频"}）`;

/** One line of facts about a standout; every number comes from the database. */
export function standoutLine(post: Standout, date: string): string {
  const parts: string[] = [];
  if (post.reasons.includes("views") || post.dayViews > 0) parts.push(`24 小时 +${count(post.dayViews)} 播放${post.views === null ? "" : `（累计 ${count(post.views)}）`}`);
  if (post.signals.length) parts.push(`信号：${post.signals.map((rule) => SIGNALS[rule] ?? rule).join("、")}`);
  if (post.ads && post.ads.registrations > 0) parts.push(`${date.slice(5)} 投放：${count(post.ads.registrations)} 注册，${money(post.ads.costPerRegistration)}/注册，花费 ${money(post.ads.spend)}`);
  return parts.join("；");
}

export interface DigestCopy { post: Standout & { pick?: CopyReason[]; costPerRegistration?: number | null }; recreationId: string; notes: ImageCopyNotes }

export function buildDigestDoc(input: { date: string; standouts: Standout[]; copies: DigestCopy[]; failedCopies: Standout[]; siteUrl: string | null; mediaDir: string }): DocItem[] {
  const items: DocItem[] = [
    { kind: "text", runs: [{ text: `播放为过去 24 小时的增量，投放为 ${input.date}（广告账户日期）。数字由程序从 Content Lab 读取。` }] },
    { kind: "heading", level: 2, text: "今日表现突出的帖子" },
  ];
  for (const post of input.standouts) {
    items.push({ kind: "bullet", runs: [
      { text: `${who(post)} `, bold: true }, { text: `${standoutLine(post, input.date)} ` },
      { text: "TikTok", link: post.url }, ...(input.siteUrl ? [{ text: " · " }, { text: "Content Lab", link: `${input.siteUrl}/posts/${post.sitePostId ?? post.postId}` }] : []),
    ] });
  }
  items.push({ kind: "heading", level: 2, text: "今日 Top 图文帖子复制版" });
  items.push({ kind: "text", runs: [{ text: `最多 ${DAILY_PHOTO_COPIES} 条：一半是累计注册成本最低的图文帖子（投放花费满 $50 且注册满 30），一半是过去 24 小时播放增长最多的；一边不够由另一边补。已经复制过的帖子不会重做。` }] });
  if (!input.copies.length) items.push({ kind: "text", runs: [{ text: input.failedCopies.length ? "今天的图文帖子复制失败，明天会再试。" : "今天没有需要复制的新图文帖子。" }] });
  for (const copy of input.copies) {
    const why = [
      ...(copy.post.pick?.includes("cheap_registrations") ? [`注册成本低：累计 ${money(copy.post.costPerRegistration ?? null)}/注册`] : []),
      ...(copy.post.pick?.includes("growth") || !copy.post.pick ? [`24 小时 +${count(copy.post.dayViews)} 播放`] : []),
    ];
    items.push({ kind: "heading", level: 3, text: `${who(copy.post)} · ${why.join(" · ")}` });
    items.push({ kind: "text", runs: [{ text: `${copy.notes.summary_zh} ` }, { text: "原帖", link: copy.post.url }] });
    const recreateDir = resolve(input.mediaDir, "..", "recreate", copy.recreationId);
    const pad = (index: number): string => String(index).padStart(2, "0");
    const link = (url: string | null | undefined): string | null => !url ? null : url.startsWith("http") ? url : input.siteUrl ? `${input.siteUrl}${url}` : null;
    const rows = (paths: Array<{ path: string; caption: string }>): void => {
      // Five images per row at most, in order.
      const present = paths.filter((item) => existsSync(item.path));
      for (let start = 0; start < present.length; start += 5) items.push({ kind: "images", images: present.slice(start, start + 5) });
    };
    const indexes = copy.notes.images.map((image) => image.index);
    items.push({ kind: "text", runs: [{ text: "原帖", bold: true }] });
    rows(indexes.map((index) => ({ path: join(input.mediaDir, copy.post.postId, `img-${pad(index)}.jpg`), caption: `第 ${index} 张` })));
    const versions = copy.notes.versions ?? copy.notes.videos?.map((video, position) => ({ version: position + 1, images: [], video, set: null })) ?? [];
    for (const version of versions) {
      const video = link(version.video);
      const set = link(version.set);
      items.push({ kind: "text", runs: [
        { text: `版本 ${version.version}`, bold: true },
        ...(set ? [{ text: " · " }, { text: "图文：下载整组图片（zip）", link: set }] : []),
        ...(video ? [{ text: " · " }, { text: "视频：下载（配原帖音乐）", link: video }] : []),
      ] });
      // The version's own image at each position, else version 1's, else the original (a kept screenshot).
      rows(indexes.map((index) => {
        const path = [version.version, 1].map((v) => join(recreateDir, `img-${pad(index)}-${v}.jpg`)).find((candidate) => existsSync(candidate)) ?? join(input.mediaDir, copy.post.postId, `img-${pad(index)}.jpg`);
        return { path, caption: `第 ${index} 张` };
      }));
    }
    if (copy.notes.rewrites?.length) {
      items.push({ kind: "text", runs: [{ text: "文字改写（原文 → 改写）", bold: true }] });
      for (const rewrite of copy.notes.rewrites.slice(0, 15)) items.push({ kind: "bullet", runs: [{ text: `${rewrite.original.replace(/\s*\n\s*/g, " / ")} → ` }, { text: rewrite.rewritten.replace(/\s*\n\s*/g, " / "), bold: true }] });
    }
  }
  for (const post of input.failedCopies) items.push({ kind: "bullet", runs: [{ text: `${who(post)} 复制失败 ` }, { text: "原帖", link: post.url }] });
  return items;
}

export function buildDigestMessage(input: { date: string; standouts: Standout[]; copies: DigestCopy[]; docUrl: string | null }): string {
  const day = `${Number(input.date.slice(5, 7))}/${Number(input.date.slice(8, 10))}`;
  const lines = input.standouts.length
    ? [`Content Lab 每日更新：过去 24 小时有 ${input.standouts.length} 条帖子表现突出（投放为 ${day}）`]
    : [`Content Lab 每日更新：过去 24 小时没有表现特别突出的帖子（${day} 投放也没有达到门槛的帖子）。`];
  input.standouts.forEach((post, index) => lines.push(`${index + 1}. ${who(post)} ${standoutLine(post, input.date)}`));
  const made = input.copies.reduce((sum, copy) => sum + copy.notes.images.reduce((n, image) => n + image.variants.length, 0), 0);
  const videos = input.copies.reduce((sum, copy) => sum + (copy.notes.videos?.length ?? 0), 0);
  if (input.copies.length) lines.push(`图文复制：已为今日 Top ${input.copies.length} 条图文帖子生成复制版，共 ${made} 张新图${videos ? `、${videos} 条配原帖音乐的视频` : ""}。`);
  if (input.docUrl) lines.push(`详情和图片：${input.docUrl}`);
  return lines.join("\n");
}

export interface DigestDeps {
  /** Copy one carousel and return its notes, or null when it failed. */
  copy: (post: Standout, recreationId: string) => Promise<ImageCopyNotes | null>;
  writer: DocWriter | null;
  send: (text: string) => Promise<void>;
  /** Remember what was reported so the next days do not repeat it; off for previews. */
  record?: boolean;
}

/**
 * The daily update: today's standouts, a copy of each standout photo carousel (made once; a retry reuses it),
 * a Feishu document with the details and images, and one message with the summary and the link.
 */
export async function runDailyDigest(db: ContentLabDatabase, config: { mediaDir: string; siteSyncUrl: string | null }, deps: DigestDeps, now = new Date()): Promise<{ standouts: number; copies: number; docUrl: string | null }> {
  const date = reportDate(now);
  const standouts = selectStandouts(db, now, recentlyReported(db, now));
  const copies: DigestCopy[] = [];
  const failedCopies: Standout[] = [];
  // Today's top photo carousels by views gained, each copied once: a carousel with a finished copy is not copied again.
  // A retry the same day reuses the copies it already made.
  const made = db.prepare("SELECT post_id, id, notes_json FROM recreations WHERE id LIKE ? AND status='complete'").all(`digest-${date}-%`) as Array<{ post_id: string; id: string; notes_json: string }>;
  for (const row of made) {
    const post = describePhoto(db, row.post_id, now);
    if (post) copies.push({ post, recreationId: row.id, notes: JSON.parse(row.notes_json) as ImageCopyNotes });
  }
  for (const post of topPhotoPosts(db, now, Math.max(0, DAILY_PHOTO_COPIES - copies.length))) {
    const recreationId = `digest-${date}-${post.postId.slice(0, 8)}`;
    const notes = await deps.copy(post, recreationId).catch(() => null);
    if (notes) copies.push({ post, recreationId, notes }); else failedCopies.push(post);
  }
  let docUrl: string | null = null;
  if ((standouts.length || copies.length || failedCopies.length) && deps.writer) {
    const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    docUrl = (await deps.writer.write(`Content Lab 每日更新 ${today}`, buildDigestDoc({ date, standouts, copies, failedCopies, siteUrl: config.siteSyncUrl, mediaDir: config.mediaDir }))).url;
  }
  await deps.send(buildDigestMessage({ date, standouts, copies, docUrl }));
  if (deps.record) for (const post of standouts) db.prepare("INSERT OR IGNORE INTO digest_posts(post_id, report_date) VALUES (?, ?)").run(post.postId, date);
  return { standouts: standouts.length, copies: copies.length, docUrl };
}

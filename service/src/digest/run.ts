import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ImageCopyNotes } from "../copy/run.js";
import type { ContentLabDatabase } from "../db/database.js";
import type { DocItem, DocWriter } from "./doc.js";
import { reportDate, selectStandouts, type Standout } from "./select.js";

/** Carousels copied per daily update; each takes a few minutes of Codex. */
export const MAX_DAILY_COPIES = 3;
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

export interface DigestCopy { post: Standout; recreationId: string; notes: ImageCopyNotes }

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
  items.push({ kind: "heading", level: 2, text: "图文帖子复制版" });
  if (!input.copies.length) items.push({ kind: "text", runs: [{ text: input.failedCopies.length ? "今天的图文帖子复制失败，明天会再试。" : "今天突出的帖子里没有图文帖子，没有生成复制版。" }] });
  for (const copy of input.copies) {
    items.push({ kind: "heading", level: 3, text: who(copy.post) });
    items.push({ kind: "text", runs: [{ text: `${copy.notes.summary_zh} ` }, { text: "原帖", link: copy.post.url }] });
    const recreateDir = resolve(input.mediaDir, "..", "recreate", copy.recreationId);
    for (const image of copy.notes.images) {
      const original = join(input.mediaDir, copy.post.postId, `img-${String(image.index).padStart(2, "0")}.jpg`);
      const version = (variant: number): string => join(recreateDir, `img-${String(image.index).padStart(2, "0")}-${variant}.jpg`);
      const images = [
        ...(existsSync(original) ? [{ path: original, caption: image.kept ? `第 ${image.index} 张 · App 截图，保持原样` : `第 ${image.index} 张 · 原图` }] : []),
        ...image.variants.map((_, index) => ({ path: version(index + 1), caption: `版本 ${index + 1}` })).filter((item) => existsSync(item.path)),
      ];
      if (images.length) items.push({ kind: "images", images });
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
  if (!input.standouts.length) return `Content Lab 每日更新：过去 24 小时没有表现特别突出的帖子（${day} 投放也没有达到门槛的帖子）。`;
  const lines = [`Content Lab 每日更新：过去 24 小时有 ${input.standouts.length} 条帖子表现突出（投放为 ${day}）`];
  input.standouts.forEach((post, index) => lines.push(`${index + 1}. ${who(post)} ${standoutLine(post, input.date)}`));
  const made = input.copies.reduce((sum, copy) => sum + copy.notes.images.reduce((n, image) => n + image.variants.length, 0), 0);
  if (input.copies.length) lines.push(`图文复制：已为 ${input.copies.length} 条图文帖子生成复制版，共 ${made} 张新图。`);
  if (input.docUrl) lines.push(`详情和图片：${input.docUrl}`);
  return lines.join("\n");
}

export interface DigestDeps {
  /** Copy one carousel and return its notes, or null when it failed. */
  copy: (post: Standout, recreationId: string) => Promise<ImageCopyNotes | null>;
  writer: DocWriter | null;
  send: (text: string) => Promise<void>;
}

/**
 * The daily update: today's standouts, a copy of each standout photo carousel (made once; a retry reuses it),
 * a Feishu document with the details and images, and one message with the summary and the link.
 */
export async function runDailyDigest(db: ContentLabDatabase, config: { mediaDir: string; siteSyncUrl: string | null }, deps: DigestDeps, now = new Date()): Promise<{ standouts: number; copies: number; docUrl: string | null }> {
  const date = reportDate(now);
  const standouts = selectStandouts(db, now);
  const copies: DigestCopy[] = [];
  const failedCopies: Standout[] = [];
  for (const post of standouts.filter((item) => item.type === "photo").slice(0, MAX_DAILY_COPIES)) {
    // The newest finished copy of this carousel is reused, whoever made it.
    const existing = db.prepare("SELECT id, notes_json FROM recreations WHERE post_id=? AND status='complete' AND notes_json LIKE '%\"kind\":\"image_copy\"%' ORDER BY created_at DESC LIMIT 1").get(post.postId) as { id: string; notes_json: string } | undefined;
    if (existing) { copies.push({ post, recreationId: existing.id, notes: JSON.parse(existing.notes_json) as ImageCopyNotes }); continue; }
    const recreationId = `digest-${date}-${post.postId.slice(0, 8)}`;
    const notes = await deps.copy(post, recreationId).catch(() => null);
    if (notes) copies.push({ post, recreationId, notes }); else failedCopies.push(post);
  }
  let docUrl: string | null = null;
  if (standouts.length && deps.writer) {
    const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    docUrl = (await deps.writer.write(`Content Lab 每日更新 ${today}`, buildDigestDoc({ date, standouts, copies, failedCopies, siteUrl: config.siteSyncUrl, mediaDir: config.mediaDir }))).url;
  }
  await deps.send(buildDigestMessage({ date, standouts, copies, docUrl }));
  return { standouts: standouts.length, copies: copies.length, docUrl };
}

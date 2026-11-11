import { describe, expect, it } from "vitest";

import { recordSnapshot, upsertPost } from "../src/collector.js";
import type { ImageCopyNotes } from "../src/copy/run.js";
import { openDatabase } from "../src/db/database.js";
import { itemBlock, type DocItem } from "../src/digest/doc.js";
import { buildDigestMessage, digestDue, money, runDailyDigest } from "../src/digest/run.js";
import { recentlyReported, reportDate, selectStandouts } from "../src/digest/select.js";

const NOW = new Date("2026-11-11T03:00:00.000Z");

function seeded() {
  const db = openDatabase(":memory:");
  const add = (index: number, type: "video" | "photo", market: string) => {
    const videoId = `74000000000000000${String(index).padStart(2, "0")}`;
    const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId, url: `https://www.tiktok.com/@c${index}/${type}/${videoId}`, authorId: `u${index}`, authorHandle: `c${index}`, caption: "", type, durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: "2026-11-05T00:00:00.000Z" } }, { market, projectTag: null, boundBy: null }, "2026-11-05T01:00:00.000Z");
    return { ...post, videoId };
  };
  const grow = (post: { id: string }, views: number, gained: number, rule: string | null) => {
    recordSnapshot(db, post as never, { views, likes: 1, comments: 0, shares: 0, saves: 0 }, "tikwm", "2026-11-11T02:00:00.000Z");
    db.prepare("INSERT OR REPLACE INTO post_hourly(post_id, hour_bucket, views_cum, views_delta, coverage) VALUES (?, '2026-11-10T20:00:00.000Z', ?, ?, 'observed')").run(post.id, views, gained);
    if (rule) db.prepare("INSERT INTO alerts(id, post_id, rule, dedupe_key, fired_at, payload_json) VALUES (?, ?, ?, ?, '2026-11-10T21:00:00.000Z', '{}')").run(`a-${post.id}-${rule}`, post.id, rule, `${post.id}:${rule}`);
  };
  const promote = (post: { videoId: string }, spend: number, registrations: number) => {
    db.prepare("INSERT INTO ad_links(ad_id, advertiser_id, tiktok_item_id, updated_at) VALUES (?, 'adv', ?, 't')").run(`ad-${post.videoId}`, post.videoId);
    db.prepare("INSERT INTO ad_daily(ad_id, stat_date, spend, impressions, clicks, installs, registrations, refreshed_at) VALUES (?, '2026-11-10', ?, 0, 0, 0, ?, 't')").run(`ad-${post.videoId}`, spend, registrations);
  };
  const viral = add(1, "video", "ID"); grow(viral, 2_000_000, 600_000, "surge"); promote(viral, 121.239, 301);
  const quiet = add(2, "video", "VN"); grow(quiet, 5_000, 100, null); promote(quiet, 5, 2);
  const paid = add(3, "video", "VN"); grow(paid, 80_000, 0, null); promote(paid, 91, 111);
  const carousel = add(4, "photo", "TH"); grow(carousel, 90_000, 20_000, "milestone");
  return { db, viral, quiet, paid, carousel };
}

describe("today's standouts", () => {
  it("are posts with a views signal in the last day or strong registrations yesterday, never quiet ones", () => {
    const { db, viral, paid, carousel } = seeded();
    expect(reportDate(NOW)).toBe("2026-11-10");
    const standouts = selectStandouts(db, NOW);
    expect(standouts.map((post) => post.postId)).toEqual([viral.id, carousel.id, paid.id]);
    expect(standouts[0]).toMatchObject({ handle: "c1", market: "ID", dayViews: 600_000, signals: ["surge"], reasons: ["views", "ads"], ads: { registrations: 301 } });
    expect(standouts[2]).toMatchObject({ reasons: ["ads"], signals: [] });
    db.close();
  });
});

describe("the daily update", () => {
  const notes: ImageCopyNotes = { kind: "image_copy", summary_zh: "1 张照片各生成 2 个版本", summary_en: "", changes: [], rewrites: [{ image: 1, original: "a", rewritten: "b" }], videos: ["/media/recreations/x/video.mp4", "/media/recreations/x/video-2.mp4"], music: true, images: [{ index: 1, kept: false, original: "o", variants: ["v1", "v2"], failed: 0 }] };

  it("copies each standout carousel once, writes the document and sends one message with program-made numbers", async () => {
    const { db, carousel } = seeded();
    const copied: string[] = [];
    const sent: string[] = [];
    let doc: { title: string; items: DocItem[] } | null = null;
    const deps = {
      copy: async (post: { postId: string }, recreationId: string) => {
        copied.push(recreationId);
        db.prepare("INSERT INTO recreations(id, post_id, site_post_id, status, notes_json, created_at, updated_at) VALUES (?, ?, ?, 'complete', ?, 't', 't')").run(recreationId, post.postId, post.postId, JSON.stringify(notes));
        return notes;
      },
      writer: { write: async (title: string, items: DocItem[]) => { doc = { title, items }; return { url: "https://acme.feishu.cn/docx/Doc1", documentId: "Doc1" }; } },
      send: async (text: string) => { sent.push(text); },
    };
    const result = await runDailyDigest(db, { mediaDir: "/nonexistent/media", siteSyncUrl: "https://lab.example" }, deps, NOW);
    expect(result).toEqual({ standouts: 3, copies: 1, docUrl: "https://acme.feishu.cn/docx/Doc1" });
    expect(copied).toEqual([`digest-2026-11-10-${carousel.id.slice(0, 8)}`]);
    expect(doc!.title).toBe("Content Lab 每日更新 2026-11-11");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("有 3 条帖子表现突出");
    expect(sent[0]).toContain("@c1（ID 视频） 24 小时 +600,000 播放（累计 2,000,000）；信号：日增爆发；11-10 投放：301 注册，$0.40/注册，花费 $121.23");
    expect(sent[0]).toContain("已为 1 条图文帖子生成复制版，共 2 张新图、2 条配原帖音乐的视频");
    expect(JSON.stringify(doc!.items)).toContain("视频：下载（配原帖音乐）");
    expect(sent[0]).toContain("https://acme.feishu.cn/docx/Doc1");
    const text = JSON.stringify(doc!.items);
    expect(text).toContain("https://lab.example/posts/");
    expect(text).toContain("文字改写（原文 → 改写）");

    // A retry the same day reuses the finished copy.
    await runDailyDigest(db, { mediaDir: "/nonexistent/media", siteSyncUrl: null }, deps, NOW);
    expect(copied).toHaveLength(1);

    // Once the group has been told, the same posts are not repeated the next days unless they pass a new milestone.
    await runDailyDigest(db, { mediaDir: "/nonexistent/media", siteSyncUrl: null }, { ...deps, record: true }, NOW);
    const nextDay = new Date(NOW.getTime() + 3_600_000);
    expect(selectStandouts(db, nextDay, recentlyReported(db, nextDay)).map((post) => post.postId)).toEqual([carousel.id]);
    const later = new Date(NOW.getTime() + 6 * 86_400_000);
    expect(recentlyReported(db, later).size).toBe(0);
    db.close();
  });

  it("says so when nothing stood out, without a document", async () => {
    const db = openDatabase(":memory:");
    const sent: string[] = [];
    const result = await runDailyDigest(db, { mediaDir: "/x", siteSyncUrl: null }, { copy: async () => null, writer: { write: async () => { throw new Error("no document expected"); } }, send: async (text) => { sent.push(text); } }, NOW);
    expect(result.docUrl).toBeNull();
    expect(sent[0]).toContain("没有表现特别突出的帖子");
    expect(buildDigestMessage({ date: "2026-11-10", standouts: [], copies: [], docUrl: null })).toBe(sent[0]);
    db.close();
  });

  it("is due once a day from 11:00 Taipei, truncates money and builds Feishu blocks", () => {
    expect(digestDue(new Date("2026-11-11T02:59:00Z"))).toBeNull();
    expect(digestDue(new Date("2026-11-11T03:00:00Z"))).toBe("daily_digest:2026-11-11");
    expect(money(0.4299)).toBe("$0.42");
    expect(money(null)).toBe("—");
    expect(itemBlock({ kind: "heading", level: 2, text: "标题" })).toMatchObject({ block_type: 4, heading2: { elements: [{ text_run: { content: "标题" } }] } });
    expect(itemBlock({ kind: "bullet", runs: [{ text: "TikTok", link: "https://www.tiktok.com/@a/video/1" }] })).toMatchObject({ block_type: 12, bullet: { elements: [{ text_run: { text_element_style: { link: { url: "https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F1" } } } }] } });
  });
});

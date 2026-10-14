import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addMemory, archiveMemory, memoriesFor, normalizeScope, ownerMemoryBlock } from "../src/agent/memory.js";
import { createAgentTools, resolvePost } from "../src/agent/tools.js";
import { upsertPost } from "../src/collector.js";
import { openDatabase } from "../src/db/database.js";
import { feishuThreadKey, handleContentLabFeishuMessage, THINKING_TEXT } from "../src/feishu/bot.js";

const message = { messageId: "om_1", chatType: "p2p" as const, senderId: "ou_owner", content: "土耳其最好的帖子？", rawContentType: "text" };

describe("Feishu agent replies", () => {
  it("shows the thinking placeholder, recalls it, then posts the answer card", async () => {
    const db = openDatabase(":memory:");
    const steps: string[] = [];
    await handleContentLabFeishuMessage({
      appId: "cli_test", allowedSenderIds: ["ou_owner"], db, message,
      reply: async (text) => { steps.push(`reply:${text}`); },
      agent: { answer: async ({ threadKey, text }) => { steps.push(`agent:${threadKey}:${text}`); return "**答案**"; }, reset: () => undefined },
      sendThinking: async () => { steps.push(`thinking:${THINKING_TEXT}`); return "om_placeholder"; },
      recall: async (id) => { steps.push(`recall:${id}`); },
      replyCard: async (markdown) => { steps.push(`card:${markdown}`); },
    });
    expect(steps).toEqual([`thinking:${THINKING_TEXT}`, "agent:feishu:p2p:ou_owner:土耳其最好的帖子？", "recall:om_placeholder", "card:**答案**"]);
    db.close();
  });

  it("still recalls the placeholder and explains when the agent fails, and /new resets the thread", async () => {
    const db = openDatabase(":memory:");
    const steps: string[] = [];
    const resets: string[] = [];
    const base = {
      appId: "cli_test", allowedSenderIds: ["ou_owner"], db,
      reply: async (text: string) => { steps.push(`reply:${text}`); },
      agent: { answer: async () => { throw new Error("boom"); }, reset: (key: string) => { resets.push(key); } },
      sendThinking: async () => "om_placeholder",
      recall: async (id: string) => { steps.push(`recall:${id}`); },
      replyCard: async (markdown: string) => { steps.push(`card:${markdown}`); },
    };
    await handleContentLabFeishuMessage({ ...base, message });
    expect(steps[0]).toBe("recall:om_placeholder");
    expect(steps[1]).toMatch(/^card:这次没能完成/);
    await handleContentLabFeishuMessage({ ...base, message: { ...message, messageId: "om_2", content: "/new" } });
    expect(resets).toEqual(["feishu:p2p:ou_owner"]);
    expect(feishuThreadKey({ ...message, chatType: "group", threadId: "omt_9" })).toBe("feishu:thread:omt_9");
    db.close();
  });

  it("rejects senders outside the allowlist without calling the agent", async () => {
    const db = openDatabase(":memory:");
    let called = false;
    const result = await handleContentLabFeishuMessage({
      appId: "cli_test", allowedSenderIds: ["ou_owner"], db, message: { ...message, senderId: "ou_stranger" },
      reply: async () => undefined, agent: { answer: async () => { called = true; return ""; }, reset: () => undefined },
    });
    expect(result).toBe("rejected");
    expect(called).toBe(false);
    db.close();
  });
});

describe("owner memory", () => {
  it("scopes memories so each post only receives the ones that apply", () => {
    const db = openDatabase(":memory:");
    expect(normalizeScope("market:vn")).toBe("market:VN");
    expect(normalizeScope("creator:@mertfe8")).toBe("creator:mertfe8");
    expect(() => normalizeScope("everything")).toThrow(/scope/);
    const vn = addMemory(db, { scope: "market:VN", kind: "fact", content: "「P tím」就是 PopUp", source: "test" });
    addMemory(db, { scope: "market:TR", kind: "rule", content: "土耳其不要建议加口播", source: "test" });
    addMemory(db, { scope: "global", kind: "preference", content: "建议要具体到第一秒", source: "test" });
    expect(memoriesFor(db, { market: "VN" }).map((memory) => memory.content).sort()).toEqual(["「P tím」就是 PopUp", "建议要具体到第一秒"].sort());
    expect(ownerMemoryBlock(memoriesFor(db, { market: "VN" }))).toContain("[fact · market:VN]");
    expect(archiveMemory(db, vn.id)).toBe(true);
    expect(memoriesFor(db, { market: "VN" })).toHaveLength(1);
    expect(ownerMemoryBlock([])).toBe("");
    db.close();
  });

  it("finds a post by local id, video id or TikTok URL", () => {
    const db = openDatabase(":memory:");
    const post = upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7412345678901234567", url: "https://www.tiktok.com/@a/video/7412345678901234567", authorId: "u1", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "TR", projectTag: null, boundBy: null });
    expect(resolvePost(db, post.id)).toBe(post.id);
    expect(resolvePost(db, "7412345678901234567")).toBe(post.id);
    expect(resolvePost(db, "https://www.tiktok.com/@a/video/7412345678901234567?lang=en")).toBe(post.id);
    expect(resolvePost(db, "nothing-like-this")).toBeNull();
    db.close();
  });
});

describe("binding posts from the agent", () => {
  it("queues new links once, reports tracked and invalid ones, and respects the daily quota", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-agent-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    try {
      upsertPost(db, { source: "tikwm", metrics: null, metadata: { videoId: "7412345678901234567", url: "https://www.tiktok.com/@a/video/7412345678901234567", authorId: "u1", authorHandle: "a", caption: "", type: "video", durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null } }, { market: "TR", projectTag: null, boundBy: null });
      const tools = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_owner", threadKey: "t", bindLimits: { dailyNewPosts: 2, maxActivePosts: 100 } });
      const bind = tools.tools.find((item) => item.name === "bind_posts")!;
      const result = await bind.handler({ market: "VN", urls: [
        "https://www.tiktok.com/@b/video/7499999999999999999?is_from_webapp=1",
        "https://www.tiktok.com/@b/video/7499999999999999999",
        "https://www.tiktok.com/@a/video/7412345678901234567",
        "https://example.com/video/1",
      ] }, {});
      const body = JSON.parse((result.content[0] as { text: string }).text) as { queued: Array<{ url: string }>; alreadyTracked: unknown[]; invalid: unknown[] };
      expect(body.queued.map((job) => job.url)).toEqual(["https://www.tiktok.com/@b/video/7499999999999999999"]);
      expect(body.alreadyTracked).toHaveLength(1);
      expect(body.invalid).toHaveLength(1);
      const job = db.prepare("SELECT payload_json FROM jobs WHERE kind='ingest'").get() as { payload_json: string };
      expect(JSON.parse(job.payload_json)).toMatchObject({ market: "VN", boundBy: "agent:feishu" });
      const over = await bind.handler({ market: "VN", urls: ["https://www.tiktok.com/@c/video/7488888888888888888", "https://www.tiktok.com/@d/video/7477777777777777777"] }, {});
      expect(over.isError).toBe(true);
      tools.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("group members", () => {
  it("answers anyone in an allowed group as a member, the owner as owner, and refuses other groups", async () => {
    const db = openDatabase(":memory:");
    const roles: string[] = [];
    const base = {
      appId: "cli_test", allowedSenderIds: ["ou_owner"], allowedChatIds: ["oc_team"], db,
      reply: async () => undefined, replyCard: async () => undefined,
      agent: { answer: async ({ role }: { role: string }) => { roles.push(role); return "ok"; }, reset: () => undefined },
    };
    const group = { ...message, chatType: "group" as const, chatId: "oc_team" };
    expect(await handleContentLabFeishuMessage({ ...base, message: { ...group, senderId: "ou_colleague" } })).toBe("answered");
    expect(await handleContentLabFeishuMessage({ ...base, message: { ...group, messageId: "om_2" } })).toBe("answered");
    expect(await handleContentLabFeishuMessage({ ...base, message: { ...group, messageId: "om_3", senderId: "ou_colleague", chatId: "oc_other" } })).toBe("rejected");
    expect(await handleContentLabFeishuMessage({ ...base, message: { ...message, messageId: "om_4", senderId: "ou_colleague" } })).toBe("rejected");
    expect(roles).toEqual(["member", "owner"]);
    db.close();
  });

  it("gives members no memory or job tools and keeps private tables out of run_sql", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-member-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    try {
      addMemory(db, { scope: "global", kind: "fact", content: "只给老板看的备注", source: "test" });
      const limits = { dailyNewPosts: 10, maxActivePosts: 10 };
      const owner = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_owner", threadKey: "t", bindLimits: limits });
      const member = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_colleague", threadKey: "t", role: "member", bindLimits: limits });
      const names = member.tools.map((item) => item.name);
      expect(names).toEqual(expect.arrayContaining(["overview", "get_post", "bind_posts", "read_feishu_doc", "run_sql"]));
      for (const name of ["remember", "forget", "list_memories", "queue_reanalysis", "queue_playbook"]) expect(names).not.toContain(name);
      expect(owner.tools.map((item) => item.name)).toContain("remember");
      const sql = member.tools.find((item) => item.name === "run_sql")!;
      expect((await sql.handler({ sql: "SELECT COUNT(*) AS n FROM posts" }, {})).isError).toBeFalsy();
      const leak = await sql.handler({ sql: "SELECT content FROM memories" }, {});
      expect(leak.isError).toBe(true);
      expect((await sql.handler({ sql: "WITH m AS (SELECT * FROM \"memories\") SELECT * FROM m" }, {})).isError).toBe(true);
      const ownerSql = owner.tools.find((item) => item.name === "run_sql")!;
      expect((await ownerSql.handler({ sql: "SELECT content FROM memories" }, {})).isError).toBeFalsy();
      owner.close();
      member.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("owner notifications", () => {
  it("sends a direct text to the first allowlisted owner, and nothing without one", async () => {
    const { ownerMessageRequest } = await import("../src/feishu/bot.js");
    expect(ownerMessageRequest(["ou_owner", "ou_two"], "重制完成")).toEqual({
      params: { receive_id_type: "open_id" },
      data: { receive_id: "ou_owner", msg_type: "text", content: JSON.stringify({ text: "重制完成" }) },
    });
    expect(ownerMessageRequest([], "x")).toBeNull();
  });
});

describe("ads in agent tools", () => {
  it("lists posts by spend with delivery totals, shows them in get_post, and lets only the owner refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-ads-agent-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    try {
      const meta = (videoId: string) => ({ videoId, url: `https://www.tiktok.com/@a/video/${videoId}`, authorId: "u1", authorHandle: "a", caption: "", type: "video" as const, durationS: 10, musicTitle: null, coverUrl: null, mediaUrl: null, imageUrls: [], publishedAt: null });
      const promoted = upsertPost(db, { source: "tikwm", metrics: null, metadata: meta("7400000000000000001") }, { market: "VN", projectTag: null, boundBy: null });
      upsertPost(db, { source: "tikwm", metrics: null, metadata: meta("7400000000000000002") }, { market: "VN", projectTag: null, boundBy: null });
      db.prepare("UPDATE posts SET ads_json=? WHERE id=?").run(JSON.stringify({ status: "active", lifetime: { spend: 120, registrations: 300, cpr: 0.4, cpi: 0.2, cpm: 3 }, last7d: { spend: 40, registrations: 100, installs: 200, impressions: 20000 }, prev7d: { spend: 20, registrations: 40, installs: 80, impressions: 10000 } }), promoted.id);
      const limits = { dailyNewPosts: 10, maxActivePosts: 10 };
      const owner = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_owner", threadKey: "t", bindLimits: limits });
      const member = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_x", threadKey: "t", role: "member", bindLimits: limits });
      const run = async (tools: typeof owner, name: string, input: Record<string, unknown>) => {
        const result = await tools.tools.find((item) => item.name === name)!.handler(input as never, {});
        return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
      };
      const listed = JSON.parse((await run(owner, "list_posts", { sort: "spend", limit: 5 })).text) as { posts: Array<{ id: string; spend: number | null; registrations: number | null }> };
      expect(listed.posts[0]).toMatchObject({ id: promoted.id, spend: 120, registrations: 300 });
      expect(listed.posts[1]?.spend).toBeNull();
      expect(JSON.parse((await run(owner, "get_post", { post: promoted.id })).text).ads).toMatchObject({ status: "active" });
      const overview = JSON.parse((await run(owner, "overview", {})).text) as { ads: Array<Record<string, unknown>> };
      expect(overview.ads).toEqual([expect.objectContaining({ market: "VN", promotedPosts: 1, activePosts: 1, spend7d: 40, registrations7d: 100, spendPrev7d: 20, cpr7d: 0.4, cprPrev7d: 0.5 })]);
      expect((await run(owner, "refresh_ads", {})).isError).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='ads_sync'").get()).toEqual({ n: 1 });
      expect(member.tools.map((item) => item.name)).not.toContain("refresh_ads");
      owner.close(); member.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("IQ market", () => {
  it("is a market everywhere: day boundaries, transcription languages, captions and binding", async () => {
    const { MARKET_UTC_OFFSET_HOURS } = await import("../src/domain/features.js");
    const { MARKET_LANGUAGES } = await import("../src/analyzer/transcribe.js");
    const { buildRecreateBrief } = await import("../src/recreate/brief.js");
    expect(MARKET_UTC_OFFSET_HOURS.IQ).toBe(3);
    expect(MARKET_LANGUAGES.IQ).toContain("ar");
    expect(buildRecreateBrief({ postId: "p", market: "IQ", durationS: 10, caption: null, transcript: null, script: [], assessment: null, playbookSummary: null, memories: "" })).toContain("Arabic (ar)");
    const dir = mkdtempSync(join(tmpdir(), "content-lab-iq-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const tools = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_owner", threadKey: "t", bindLimits: { dailyNewPosts: 10, maxActivePosts: 10 } });
    const bind = tools.tools.find((item) => item.name === "bind_posts")!;
    const parsed = (bind.inputSchema as unknown as { market: { safeParse: (value: unknown) => { success: boolean } } }).market.safeParse("IQ");
    expect(parsed.success).toBe(true);
    tools.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe("binding from a Feishu sheet", () => {
  it("summarizes a big sheet, then binds its links per market only after confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-docbind-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const link = (id: number) => `https://www.tiktok.com/@k/video/7410000000000${String(id).padStart(6, "0")}`;
    const lines = ["达人\t国家\t链接", ...Array.from({ length: 1_200 }, (_, index) => `k${index}\t${index % 2 ? "越南" : "TR"}\t${link(index)}`), "x\t越南\thttps://www.tiktok.com/@onlyaprofile", `y\t\t${link(5_000)}`];
    const doc = { kind: "sheet" as const, title: "KOL", text: lines.join("\n").slice(0, 40_000), truncated: true, tiktokUrls: [], lines };
    const tools = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_x", threadKey: "t", role: "member", bindLimits: { dailyNewPosts: 300, maxActivePosts: 5_000 }, readFeishuDoc: async () => doc });
    const run = async (name: string, input: Record<string, unknown>) => {
      const result = await tools.tools.find((item) => item.name === name)!.handler(input as never, {});
      return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
    };
    const read = await run("read_feishu_doc", { url: "https://acme.feishu.cn/sheets/Sht0000000001" });
    expect(read.text.length).toBeLessThan(8_000);
    expect(JSON.parse(read.text)).toMatchObject({ links: 1_202, linksByMarket: { TR: 600, VN: 601, unknown: 1 } });
    const plan = JSON.parse((await run("bind_feishu_doc", { url: "https://acme.feishu.cn/sheets/Sht0000000001" })).text) as { bound: boolean; byMarket: Record<string, { new: number }>; invalid: number; noMarket: number };
    expect(plan).toMatchObject({ bound: false, invalid: 1, noMarket: 1 });
    expect(plan.byMarket.VN!.new).toBe(600);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='ingest'").get()).toEqual({ n: 0 });
    const done = JSON.parse((await run("bind_feishu_doc", { url: "https://acme.feishu.cn/sheets/Sht0000000001", confirm: true })).text) as { bound: boolean; queued: number; notQueued: number; stoppedBy: string | null };
    expect(done).toMatchObject({ bound: true, queued: 300, notQueued: 900, stoppedBy: "daily_quota_exceeded" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='ingest'").get()).toEqual({ n: 300 });
    tools.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe("binding a chosen slice of a sheet", () => {
  it("binds only the 2026 tab's TikTok rows from the last 30 days, by Area", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-slice-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const link = (id: number) => `https://www.tiktok.com/@k/video/7420000000000${String(id).padStart(6, "0")}`;
    const recent = 46_300 + Math.floor((Date.now() - Date.parse("2026-10-04T00:00:00Z")) / 86_400_000);
    const lines = ["## 2025", "Creator\tArea\tChannel\tVideo Post Date\tLink", `a\tVN\tTT\t${recent}\t${link(1)}`,
      "## 2026", "Creator\tArea\tChannel\tVideo Post Date\tLink", `b\tVN\tTT\t${recent}\t${link(2)}`, `c\tID\tTT\t${recent - 2}\t${link(3)}`, `d\tID\tFB\t${recent}\t${link(4)}`, `e\tTR\tTT\t${recent - 90}\t${link(5)}`];
    let allTabs: boolean | undefined;
    const tools = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_x", threadKey: "t", role: "member", bindLimits: { dailyNewPosts: 300, maxActivePosts: 5_000 },
      readFeishuDoc: async (_url, options) => { allTabs = options?.allTabs; return { kind: "sheet", title: "KOL", text: "", truncated: false, tiktokUrls: [], lines }; } });
    const bind = tools.tools.find((item) => item.name === "bind_feishu_doc")!;
    const result = await bind.handler({ url: "https://acme.feishu.cn/sheets/Sht0000000001?sheet=other", tab: "2026", filters: [{ column: "Channel", equals: "TT" }], days: 30, date_column: "Video Post Date", confirm: true } as never, {});
    const body = JSON.parse((result.content[0] as { text: string }).text) as { queued: number; byMarket: Record<string, { new: number }> };
    expect(allTabs).toBe(true);
    expect(body.queued).toBe(2);
    expect(body.byMarket).toEqual({ VN: { new: 1, alreadyTracked: 0 }, ID: { new: 1, alreadyTracked: 0 } });
    tools.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe("querying and binding a sheet with SQL", () => {
  it("shows the tables, answers a query, and binds the query's links per market after confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "content-lab-sql-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const link = (id: number) => `https://www.tiktok.com/@k/video/7440000000000${String(id).padStart(6, "0")}`;
    const lines = ["## 2026", "Creator\tArea\tChannel\tVideo Post Date\tLink", `b\tVN\tTT\t46300\t${link(2)}`, `c\tID\tTT\t46300\t${link(3)}`, `d\tID\tFB\t46300\t${link(4)}`, `e\tTR\tTT\t46000\t${link(5)}`, `f\tTR\tTT\t46300\thttps://www.tiktok.com/@profile`];
    let reads = 0;
    const tools = createAgentTools({ db, dbPath, channel: "feishu", author: "ou_x", threadKey: "t", role: "member", bindLimits: { dailyNewPosts: 300, maxActivePosts: 5_000 },
      readFeishuDoc: async () => { reads += 1; return { kind: "sheet", title: "KOL", text: "", truncated: false, tiktokUrls: [], lines }; } });
    const run = async (name: string, input: Record<string, unknown>) => {
      const result = await tools.tools.find((item) => item.name === name)!.handler(input as never, {});
      return { text: (result.content[0] as { text: string }).text, isError: result.isError === true };
    };
    const doc = "https://acme.feishu.cn/sheets/Sht0000000001";
    const tables = JSON.parse((await run("query_feishu_doc", { url: doc })).text) as { tables: Array<{ table: string; columns: string[] }> };
    expect(tables.tables[0]).toMatchObject({ table: "t1", columns: expect.arrayContaining(["Area", "Video Post Date", "_links"]) });
    const sql = `SELECT _links AS link, market_of(Area) AS market FROM t1 WHERE Channel = 'TT' AND to_date("Video Post Date") >= '2026-09-14'`;
    expect(JSON.parse((await run("query_feishu_doc", { url: doc, sql })).text)).toMatchObject({ count: 3 });
    expect((await run("query_feishu_doc", { url: doc, sql: "DROP TABLE t1" })).isError).toBe(true);
    const plan = JSON.parse((await run("bind_feishu_query", { url: doc, sql })).text) as { bound: boolean; byMarket: Record<string, { new: number }>; invalid: number };
    expect(plan).toMatchObject({ bound: false, invalid: 1, byMarket: { VN: { new: 1, alreadyTracked: 0 }, ID: { new: 1, alreadyTracked: 0 } } });
    const done = JSON.parse((await run("bind_feishu_query", { url: doc, sql, confirm: true })).text) as { queued: number };
    expect(done.queued).toBe(2);
    expect(reads).toBe(1);
    tools.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

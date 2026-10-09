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

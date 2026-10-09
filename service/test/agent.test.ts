import { describe, expect, it } from "vitest";

import { addMemory, archiveMemory, memoriesFor, normalizeScope, ownerMemoryBlock } from "../src/agent/memory.js";
import { resolvePost } from "../src/agent/tools.js";
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

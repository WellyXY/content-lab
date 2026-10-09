import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  LoggerLevel,
  createLarkChannel,
  type LarkChannel,
  type WSConnectionStatus,
} from "@larksuiteoapi/node-sdk";

import type { ContentLabDatabase } from "../db/database.js";
import type { FeishuAlertTransport } from "../feishu.js";
import { assertFeishuSuccess } from "./api.js";
import { answerContentLabQuery } from "./query.js";

export interface ContentLabFeishuBotOptions {
  appId: string;
  appSecret: string;
  alertChatId: string | null;
  alertOpenId: string | null;
  allowedSenderIds: readonly string[];
  allowedChatIds: readonly string[];
  lockPath: string;
  db: ContentLabDatabase;
  /** Conversational answers; without it the bot only runs the fixed queries. */
  agent?: FeishuAgent;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface FeishuAgent {
  /** `owner` is a sender on the DM allowlist; anyone else in an allowed group is a `member`. */
  answer: (input: { threadKey: string; author: string; role: "owner" | "member"; text: string }) => Promise<string>;
  reset: (threadKey: string) => void;
}

export const THINKING_TEXT = "思考中…";
/** Feishu cards hold about 30 KB; keep answers well inside it. */
const MAX_ANSWER_CHARS = 9_000;

export const answerCard = (markdown: string): Record<string, unknown> => ({
  config: { wide_screen_mode: true },
  elements: [{ tag: "markdown", content: markdown.length > MAX_ANSWER_CHARS ? `${markdown.slice(0, MAX_ANSWER_CHARS)}\n\n…（回复过长，已截断）` : markdown }],
});

/** One ongoing conversation per direct chat, one per thread in a group. */
export const feishuThreadKey = (message: ContentLabInboundMessage): string => message.chatType === "p2p"
  ? `feishu:p2p:${message.senderId}`
  : `feishu:thread:${message.threadId ?? message.messageId}`;

export interface ContentLabFeishuBot {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  connectionStatus: () => WSConnectionStatus | undefined;
  identity: () => { openId: string; name: string } | null;
  /** Direct message to the owner; a no-op without one. */
  notifyOwner: (text: string) => Promise<void>;
  alertTransport: FeishuAlertTransport | null;
}

const NO_GROUP_ACCESS = "oc_content_lab_group_queries_disabled";

export const failClosedGroupAllowlist = (chatIds: readonly string[]): string[] => chatIds.length > 0
  ? [...chatIds]
  : [NO_GROUP_ACCESS];

/** A direct text message to the owner (the first DM-allowlisted open ID), or null when none is set. */
export function ownerMessageRequest(allowedSenderIds: readonly string[], text: string): { params: { receive_id_type: "open_id" }; data: { receive_id: string; msg_type: "text"; content: string } } | null {
  const owner = allowedSenderIds[0];
  if (!owner) return null;
  return { params: { receive_id_type: "open_id" }, data: { receive_id: owner, msg_type: "text", content: JSON.stringify({ text }) } };
}

export function resolveFeishuAlertTarget(chatId: string | null, openId: string | null): { type: "chat_id" | "open_id"; id: string } | null {
  if (chatId && openId) throw new Error("Set only one of FEISHU_ALERT_CHAT_ID or FEISHU_ALERT_OPEN_ID");
  if (chatId) return { type: "chat_id", id: chatId };
  if (openId) return { type: "open_id", id: openId };
  return null;
}

export interface ContentLabInboundMessage {
  messageId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  rawContentType: string;
  chatId?: string;
  threadId?: string;
}

export const feishuReplyUuid = (appId: string, messageId: string): string => createHash("sha256")
  .update(`${appId}:${messageId}`)
  .digest("hex")
  .slice(0, 50);

export async function handleContentLabFeishuMessage(input: {
  appId: string;
  allowedSenderIds: readonly string[];
  /** Group chats where anyone who mentions the bot gets an answer. */
  allowedChatIds?: readonly string[];
  db: ContentLabDatabase;
  message: ContentLabInboundMessage;
  reply: (text: string, uuid: string, replyInThread: boolean) => Promise<void>;
  agent?: FeishuAgent;
  /** Sends the thinking placeholder and returns its message id. */
  sendThinking?: () => Promise<string | null>;
  recall?: (messageId: string) => Promise<void>;
  replyCard?: (markdown: string, uuid: string, replyInThread: boolean) => Promise<void>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): Promise<"answered" | "rejected"> {
  const { message } = input;
  const log = input.log ?? (() => undefined);
  const isOwner = input.allowedSenderIds.includes(message.senderId);
  const allowedGroup = message.chatType === "group" && Boolean(message.chatId) && (input.allowedChatIds ?? []).includes(message.chatId!);
  if (!isOwner && !allowedGroup) {
    log("feishu_message_rejected", { reason: "sender_not_allowed" });
    return "rejected";
  }
  const reply = (text: string) => input.reply(text, feishuReplyUuid(input.appId, message.messageId), Boolean(message.threadId));
  if (!new Set(["text", "post"]).has(message.rawContentType)) {
    await reply("目前只支援文字查詢。輸入「幫助」查看可用指令。");
    return "answered";
  }
  if (message.content.length > 2_000) {
    await reply("查詢內容過長；請縮短到 2,000 字以內。");
    return "answered";
  }
  const question = message.content.trim();
  const threadKey = feishuThreadKey(message);
  if (input.agent && /^\/(new|新对话|新對話|reset)\b/i.test(question)) {
    input.agent.reset(threadKey);
    await reply("已开始新对话。");
    return "answered";
  }
  if (input.agent && !question.startsWith("/")) {
    // Acknowledge at once, then recall the placeholder and post the answer.
    const placeholder = await input.sendThinking?.().catch((error: unknown) => {
      log("feishu_thinking_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }) ?? null;
    let answer: string;
    try {
      answer = await input.agent.answer({ threadKey, author: message.senderId, role: isOwner ? "owner" : "member", text: question });
      log("feishu_agent_answered", { chatType: message.chatType, chars: answer.length });
    } catch (error) {
      log("feishu_agent_failed", { error: error instanceof Error ? error.message : String(error) });
      answer = /usage limit|limit reached|rate.?limit/i.test(String(error)) ? "Claude 用量暂时到达上限，请稍后再问。" : "这次没能完成回答，请稍后再试，或换个问法。";
    }
    if (placeholder) await input.recall?.(placeholder).catch((error: unknown) => log("feishu_recall_failed", { error: error instanceof Error ? error.message : String(error) }));
    const uuid = feishuReplyUuid(input.appId, message.messageId);
    if (input.replyCard) await input.replyCard(answer, uuid, Boolean(message.threadId));
    else await input.reply(answer, uuid, Boolean(message.threadId));
    return "answered";
  }
  let text: string;
  try {
    text = answerContentLabQuery(input.db, question.replace(/^\//, ""));
  } catch (error) {
    log("feishu_query_failed", { error: error instanceof Error ? error.message : String(error) });
    text = "Content Lab 查詢暫時失敗，請稍後再試。";
  }
  await reply(text);
  log("feishu_query_answered", { chatType: message.chatType, queryType: message.rawContentType });
  return "answered";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireProcessLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const owner = `${process.pid}:${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try { writeFileSync(descriptor, owner, "utf8"); } finally { closeSync(descriptor); }
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === owner) unlinkSync(path);
        } catch { /* another process already cleaned up the exact lock */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid = 0;
      try { existingPid = Number.parseInt(readFileSync(path, "utf8").split(":", 1)[0] ?? "", 10); } catch { /* stale */ }
      if (Number.isSafeInteger(existingPid) && existingPid > 0 && processIsAlive(existingPid)) {
        throw new Error(`Feishu WebSocket is already owned by process ${existingPid}`);
      }
      try { unlinkSync(path); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire the Feishu WebSocket process lock");
}

export function createContentLabFeishuBot(options: ContentLabFeishuBotOptions): ContentLabFeishuBot {
  const log = options.log ?? (() => undefined);
  let channel: LarkChannel;
  let connected = false;
  let releaseLock: (() => void) | null = null;

  const makeChannel = (): LarkChannel => {
    const instance = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      transport: "websocket",
      source: "content-lab",
      loggerLevel: LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      policy: {
        requireMention: true,
        respondToMentionAll: false,
        groupAllowlist: failClosedGroupAllowlist(options.allowedChatIds),
        dmMode: "allowlist",
        dmAllowlist: [...options.allowedSenderIds],
      },
      safety: {
        staleMessageWindowMs: 5 * 60_000,
        chatQueue: { enabled: true },
        dedup: { ttl: 10 * 60_000, maxEntries: 5_000, sweepIntervalMs: 60_000 },
      },
      outbound: { textChunkLimit: 3_000, retry: { maxAttempts: 2, baseDelayMs: 500 } },
    });

    instance.on("message", async (message) => {
      await handleContentLabFeishuMessage({
        appId: options.appId,
        allowedSenderIds: options.allowedSenderIds,
        allowedChatIds: options.allowedChatIds,
        db: options.db,
        message,
        log,
        ...(options.agent ? {
          agent: options.agent,
          sendThinking: async () => {
            const response = await instance.rawClient.im.v1.message.reply({
              path: { message_id: message.messageId },
              data: { msg_type: "text", content: JSON.stringify({ text: THINKING_TEXT }), reply_in_thread: Boolean(message.threadId) },
            });
            assertFeishuSuccess(response, "Feishu thinking placeholder");
            return response.data?.message_id ?? null;
          },
          recall: async (messageId: string) => {
            const response = await instance.rawClient.im.v1.message.delete({ path: { message_id: messageId } });
            assertFeishuSuccess(response, "Feishu message.delete");
          },
          replyCard: async (markdown: string, uuid: string, replyInThread: boolean) => {
            const response = await instance.rawClient.im.v1.message.reply({
              path: { message_id: message.messageId },
              data: { msg_type: "interactive", content: JSON.stringify(answerCard(markdown)), reply_in_thread: replyInThread, uuid },
            });
            assertFeishuSuccess(response, "Feishu answer card");
          },
        } : {}),
        reply: async (text, uuid, replyInThread) => {
          const response = await instance.rawClient.im.v1.message.reply({
            path: { message_id: message.messageId },
            data: {
              msg_type: "text",
              content: JSON.stringify({ text }),
              reply_in_thread: replyInThread,
              uuid,
            },
          });
          assertFeishuSuccess(response, "Feishu message.reply");
        },
      });
    });
    // The chat id of a refused group is logged locally so the owner can choose to allow it.
    instance.on("reject", (event) => log("feishu_message_rejected", { reason: event.reason, ...(event.reason === "group_not_allowed" ? { chatId: event.chatId } : {}) }));
    instance.on("error", (error) => log("feishu_bot_error", { code: error.code, error: error.message }));
    instance.on("reconnecting", () => log("feishu_bot_reconnecting"));
    instance.on("reconnected", () => log("feishu_bot_reconnected"));
    return instance;
  };

  channel = makeChannel();

  const connect = async (): Promise<void> => {
    const state = channel.getConnectionStatus()?.state;
    if (connected && state !== "failed" && state !== "idle") return;
    if (state === "failed" || state === "idle") {
      channel.rawWsClient?.close({ force: true });
      channel = makeChannel();
    }
    try {
      releaseLock ??= acquireProcessLock(options.lockPath);
      await channel.connect();
      connected = true;
    } catch (error) {
      connected = false;
      channel.rawWsClient?.close({ force: true });
      releaseLock?.();
      releaseLock = null;
      throw error;
    }
  };

  const disconnect = async (): Promise<void> => {
    channel.rawWsClient?.close({ force: true });
    await channel.disconnect();
    connected = false;
    releaseLock?.();
    releaseLock = null;
  };

  const alertTarget = resolveFeishuAlertTarget(options.alertChatId, options.alertOpenId);
  const alertTransport: FeishuAlertTransport | null = alertTarget ? {
    name: "app-bot",
    async sendCard(card, idempotencyKey) {
      const response = await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: alertTarget.type },
        data: {
          receive_id: alertTarget.id,
          msg_type: "interactive",
          content: JSON.stringify(card),
          uuid: idempotencyKey,
        },
      });
      assertFeishuSuccess(response, "Feishu message.create");
    },
  } : null;

  return {
    connect,
    disconnect,
    connectionStatus: () => channel.getConnectionStatus(),
    identity: () => channel.botIdentity ? { openId: channel.botIdentity.openId, name: channel.botIdentity.name } : null,
    alertTransport,
    notifyOwner: async (text: string) => {
      const request = ownerMessageRequest(options.allowedSenderIds, text);
      if (!request) return;
      const response = await channel.rawClient.im.v1.message.create(request);
      assertFeishuSuccess(response, "Feishu owner notification");
    },
  };
}

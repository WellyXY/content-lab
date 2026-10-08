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
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ContentLabFeishuBot {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  connectionStatus: () => WSConnectionStatus | undefined;
  identity: () => { openId: string; name: string } | null;
  alertTransport: FeishuAlertTransport | null;
}

const NO_GROUP_ACCESS = "oc_content_lab_group_queries_disabled";

export const failClosedGroupAllowlist = (chatIds: readonly string[]): string[] => chatIds.length > 0
  ? [...chatIds]
  : [NO_GROUP_ACCESS];

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
  threadId?: string;
}

export const feishuReplyUuid = (appId: string, messageId: string): string => createHash("sha256")
  .update(`${appId}:${messageId}`)
  .digest("hex")
  .slice(0, 50);

export async function handleContentLabFeishuMessage(input: {
  appId: string;
  allowedSenderIds: readonly string[];
  db: ContentLabDatabase;
  message: ContentLabInboundMessage;
  reply: (text: string, uuid: string, replyInThread: boolean) => Promise<void>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): Promise<"answered" | "rejected"> {
  const { message } = input;
  const log = input.log ?? (() => undefined);
  if (!input.allowedSenderIds.includes(message.senderId)) {
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
  let text: string;
  try {
    text = answerContentLabQuery(input.db, message.content);
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
        db: options.db,
        message,
        log,
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
    instance.on("reject", (event) => log("feishu_message_rejected", { reason: event.reason }));
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
  };
}

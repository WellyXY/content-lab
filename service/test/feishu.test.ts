import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { assertFeishuSuccess } from "../src/feishu/api.js";
import {
  failClosedGroupAllowlist,
  feishuReplyUuid,
  handleContentLabFeishuMessage,
  resolveFeishuAlertTarget,
} from "../src/feishu/bot.js";
import {
  FEISHU_KEYCHAIN_SERVICES,
  keychainStoreArgv,
  onboardFeishuApp,
} from "../src/feishu/onboard.js";
import { answerContentLabQuery } from "../src/feishu/query.js";
import { REQUIRED_FEISHU_SCOPES, missingRequiredFeishuScopes } from "../src/feishu/scopes.js";
import { deliverAlertOutbox, type FeishuAlertTransport } from "../src/feishu.js";

const dirs: string[] = [];
const testDb = () => {
  const directory = mkdtempSync(join(tmpdir(), "content-lab-feishu-"));
  dirs.push(directory);
  return openDatabase(join(directory, "test.sqlite"));
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Feishu onboarding", () => {
  it("updates only the exact existing app with the minimal preset and writes credentials", async () => {
    let received: Record<string, unknown> | null = null;
    const writes: Array<{ service: string; account: string; value: string }> = [];
    const qr = vi.fn();
    const result = await onboardFeishuApp({ appId: "cli_existing123", account: "tester" }, {
      register: (async (options: Record<string, unknown>) => {
        received = options;
        (options.onQRCodeReady as (input: { url: string; expireIn: number }) => void)({ url: "https://safe.example/device", expireIn: 60 });
        return { client_id: "cli_existing123", client_secret: "never-print-me", user_info: { open_id: "ou_owner123" } };
      }) as never,
      onQrCode: qr,
      store: async (service, account, value) => { writes.push({ service, account, value }); },
    });

    expect(Object.keys(received ?? {}).sort()).toEqual(["addons", "appId", "onQRCodeReady"]);
    expect(received).toHaveProperty("addons", { preset: false });
    expect(received).not.toHaveProperty("createOnly");
    expect(qr).toHaveBeenCalledWith({ url: "https://safe.example/device", expireIn: 60 });
    expect(writes).toContainEqual({ service: FEISHU_KEYCHAIN_SERVICES.appSecret, account: "cli_existing123", value: "never-print-me" });
    expect(result).toEqual({ ok: true, appId: "cli_existing123", service: FEISHU_KEYCHAIN_SERVICES.appSecret });
  });

  it("does not write anything when registerApp returns a different client id", async () => {
    const store = vi.fn(async () => undefined);
    await expect(onboardFeishuApp({ appId: "cli_expected123", account: "tester" }, {
      register: (async () => ({ client_id: "cli_other123", client_secret: "secret", user_info: { open_id: "ou_owner" } })) as never,
      store,
    })).rejects.toThrow(/different/);
    expect(store).not.toHaveBeenCalled();
  });

  it("keeps the secret out of the security process argv", () => {
    const secret = "secret-that-must-use-stdin";
    const args = keychainStoreArgv(FEISHU_KEYCHAIN_SERVICES.appSecret, "cli_existing123");
    expect(args).not.toContain(secret);
    expect(args[0]).toBe("swift");
    expect(args[1]).toMatch(/keychain-write\.swift$/);
    expect(args).toContain("cli_existing123");
  });
});

describe("Feishu query safety", () => {
  it("fails closed for empty allowlists and rejects an unlisted group sender without replying", async () => {
    const db = testDb();
    const reply = vi.fn(async () => undefined);
    expect(failClosedGroupAllowlist([])).toHaveLength(1);
    expect(failClosedGroupAllowlist([])).not.toContain("oc_unlisted");
    await expect(handleContentLabFeishuMessage({
      appId: "cli_app123",
      allowedSenderIds: [],
      db,
      message: { messageId: "om_1", chatType: "group", senderId: "ou_unlisted", content: "概覽", rawContentType: "text" },
      reply,
    })).resolves.toBe("rejected");
    expect(reply).not.toHaveBeenCalled();
    db.close();
  });

  it("uses one stable reply uuid and preserves thread replies for an allowed sender", async () => {
    const db = testDb();
    const reply = vi.fn(async () => undefined);
    await handleContentLabFeishuMessage({
      appId: "cli_app123",
      allowedSenderIds: ["ou_allowed"],
      db,
      message: { messageId: "om_2", chatType: "group", senderId: "ou_allowed", content: "幫助", rawContentType: "text", threadId: "omt_thread" },
      reply,
    });
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[1]).toBe(feishuReplyUuid("cli_app123", "om_2"));
    expect(reply.mock.calls[0]?.[2]).toBe(true);
    expect(feishuReplyUuid("cli_app123", "om_2")).toHaveLength(50);
    db.close();
  });

  it("returns an explicit no-real-data result for an empty Content Lab database", () => {
    const db = testDb();
    expect(answerContentLabQuery(db, "概覽")).toBe("Content Lab 尚無真實資料。");
    db.close();
  });

  it("never exposes job payloads or last errors", () => {
    const db = testDb();
    const now = "2026-10-08T00:00:00.000Z";
    db.prepare(`
      INSERT INTO jobs(id,kind,payload_json,status,run_at,last_error,created_at,updated_at)
      VALUES ('job-1','capture',?,'dead',?,?,?,?)
    `).run(JSON.stringify({ token: "PAYLOAD_SECRET" }), now, "LAST_ERROR_SECRET", now, now);
    const answer = answerContentLabQuery(db, "任務");
    expect(answer).toContain("dead/capture");
    expect(answer).not.toContain("PAYLOAD_SECRET");
    expect(answer).not.toContain("LAST_ERROR_SECRET");
    db.close();
  });

  it("rejects conflicting alert targets", () => {
    expect(() => resolveFeishuAlertTarget("oc_chat", "ou_user")).toThrow(/only one/);
  });
});

describe("Feishu contracts", () => {
  it("checks only the three scopes used by the runtime", () => {
    expect(REQUIRED_FEISHU_SCOPES).toEqual([
      "im:message:send_as_bot",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
    ]);
    expect(missingRequiredFeishuScopes([
      { scope_name: "im:message:send_as_bot", grant_status: 1, scope_type: "tenant" },
      { scope_name: "im:message.group_at_msg:readonly", grant_status: 1, scope_type: "tenant" },
    ])).toEqual(["im:message.p2p_msg:readonly"]);
  });

  it("treats non-zero and missing Feishu response codes as failures", () => {
    expect(() => assertFeishuSuccess({ code: 99, msg: "denied" }, "test")).toThrow(/99/);
    expect(() => assertFeishuSuccess({}, "test")).toThrow(/missing code/);
    expect(() => assertFeishuSuccess({ code: 0 }, "test")).not.toThrow();
  });

  it("prefers the hosted site post id in alert links and falls back between transports", async () => {
    const db = testDb();
    const now = "2026-10-08T00:00:00.000Z";
    db.prepare(`
      INSERT INTO posts(id,video_id,url,bound_at,created_at,updated_at,site_post_id)
      VALUES ('local-post','7412345678901234567','https://www.tiktok.com/@a/video/7412345678901234567',?,?,?,'site-post')
    `).run(now, now, now);
    const sentinel = "SECRET_error_detail_must_not_leave_local_logs";
    db.prepare(`
      INSERT INTO alerts(id,post_id,rule,dedupe_key,fired_at,payload_json,next_delivery_at)
      VALUES ('alert-1','local-post','milestone','dedupe-1',?,? ,?)
    `).run(now, JSON.stringify({ postId: "local-post", currentViews: 100_000, error: sentinel }), now);
    const primary: FeishuAlertTransport = { name: "app-bot", sendCard: vi.fn(async () => { throw new Error("unavailable"); }) };
    let captured: Record<string, unknown> | null = null;
    const fallback: FeishuAlertTransport = { name: "webhook", sendCard: vi.fn(async (card) => { captured = card; }) };

    await expect(deliverAlertOutbox(db, [primary, fallback], "https://content-lab.example")).resolves.toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(primary.sendCard).toHaveBeenCalledOnce();
    expect(fallback.sendCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(captured)).toContain("https://content-lab.example/posts/site-post");
    expect(JSON.stringify(captured)).not.toContain("/posts/local-post");
    expect(JSON.stringify(captured)).not.toContain(sentinel);
    expect(answerContentLabQuery(db, "告警 5")).not.toContain(sentinel);
    db.close();
  });
});

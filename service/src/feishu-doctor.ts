import { AppType, Client, Domain } from "@larksuiteoapi/node-sdk";

import { assertFeishuSuccess } from "./feishu/api.js";
import { FEISHU_KEYCHAIN_SERVICES, keychainRead } from "./feishu/onboard.js";
import { REQUIRED_FEISHU_SCOPES, missingRequiredFeishuScopes } from "./feishu/scopes.js";

const args = process.argv.slice(2);
const inline = args.find((arg) => arg.startsWith("--app-id="))?.slice("--app-id=".length);
const index = args.indexOf("--app-id");
const account = process.env.USER?.trim() || "welly";

try {
  const appId = (inline || (index >= 0 ? args[index + 1] : null) || process.env.FEISHU_APP_ID
    || await keychainRead(FEISHU_KEYCHAIN_SERVICES.appId, account)).trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("invalid app id");
  const appSecret = process.env.FEISHU_APP_SECRET?.trim()
    || await keychainRead(FEISHU_KEYCHAIN_SERVICES.appSecret, appId);
  const client = new Client({ appId, appSecret, appType: AppType.SelfBuild, domain: Domain.Feishu });
  const bot = await client.request<{ code?: number; bot?: { open_id?: string } }>({ url: "/open-apis/bot/v3/info", method: "GET" });
  assertFeishuSuccess(bot, "Feishu bot info");
  if (!bot.bot?.open_id) throw new Error("bot identity missing");
  const scopeResponse = await client.application.v6.scope.list({});
  assertFeishuSuccess(scopeResponse, "Feishu scope list");
  const missingScopes = missingRequiredFeishuScopes(scopeResponse.data?.scopes ?? []);
  console.log(JSON.stringify({ ok: missingScopes.length === 0, appId, bot: "ok", missingScopes }));
  if (missingScopes.length > 0) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, bot: "failed", missingScopes: [...REQUIRED_FEISHU_SCOPES], error: "doctor_failed" }));
  process.exitCode = 1;
}

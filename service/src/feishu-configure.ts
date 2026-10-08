import { AppType, Client, Domain } from "@larksuiteoapi/node-sdk";

import { assertFeishuSuccess } from "./feishu/api.js";
import { FEISHU_KEYCHAIN_SERVICES, keychainRead } from "./feishu/onboard.js";
import { missingRequiredFeishuScopes } from "./feishu/scopes.js";

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
  const scopes = await client.application.v6.scope.list({});
  assertFeishuSuccess(scopes, "Feishu scope list");
  const missingScopes = missingRequiredFeishuScopes(scopes.data?.scopes ?? []);
  if (missingScopes.length > 0) {
    console.log(JSON.stringify({ ok: false, appId, missingScopes, error: "missing_scopes" }));
    process.exitCode = 1;
  } else {
    const eventConfig = await client.application.v7.applicationConfig.patch({
      path: { app_id: appId },
      data: { event: { subscription_type: "websocket", add_events: ["im.message.receive_v1"] } },
    });
    assertFeishuSuccess(eventConfig, "Feishu event configuration");
    console.log(JSON.stringify({ ok: true, appId, transport: "websocket", event: "im.message.receive_v1" }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, error: "configure_failed" }));
  process.exitCode = 1;
}

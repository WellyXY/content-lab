import { onboardFeishuApp } from "./feishu/onboard.js";

const args = process.argv.slice(2);
const inline = args.find((arg) => arg.startsWith("--app-id="))?.slice("--app-id=".length);
const index = args.indexOf("--app-id");
const appId = (inline || (index >= 0 ? args[index + 1] : null) || process.env.FEISHU_APP_ID || "").trim();
const account = process.env.USER?.trim() || "welly";

try {
  const result = await onboardFeishuApp(
    { appId, account, sendTest: args.includes("--send-test") },
    { onQrCode: ({ url, expireIn }) => console.log(JSON.stringify({ ok: false, status: "authorization_required", url, expireIn })) },
  );
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, appId: appId || null, service: "com.welly.content-lab.feishu-app-secret", error: "setup_failed" }));
  process.exitCode = 1;
}

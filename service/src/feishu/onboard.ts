import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AppType,
  Client,
  Domain,
  registerApp,
} from "@larksuiteoapi/node-sdk";

import { assertFeishuSuccess } from "./api.js";

export const FEISHU_KEYCHAIN_SERVICES = {
  appId: "com.welly.content-lab.feishu-app-id",
  appSecret: "com.welly.content-lab.feishu-app-secret",
  ownerOpenId: "com.welly.content-lab.feishu-owner-open-id",
} as const;

const execFileAsync = promisify(execFile);

export interface FeishuOnboardResult {
  ok: boolean;
  appId: string;
  service: string;
  error?: "owner_open_id_missing";
  testSent?: boolean;
}

const KEYCHAIN_WRITER_PATH = fileURLToPath(new URL("../../scripts/keychain-write.swift", import.meta.url));

export const keychainStoreArgv = (service: string, account: string): string[] => [
  "swift", KEYCHAIN_WRITER_PATH, service, account,
];

type RegisterOptions = Parameters<typeof registerApp>[0];
type RegistrationResult = Awaited<ReturnType<typeof registerApp>>;

interface OnboardDependencies {
  register: (options: RegisterOptions) => Promise<RegistrationResult>;
  onQrCode: (info: { url: string; expireIn: number }) => void;
  store: (service: string, account: string, value: string) => Promise<void>;
  sendTest: (appId: string, appSecret: string, openId: string) => Promise<void>;
}

export function keychainStoreFromStdin(service: string, account: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/xcrun", keychainStoreArgv(service, account), {
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const failure = () => finish(new Error(`Could not write Keychain service ${service}`));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      failure();
    }, 60_000);
    timeout.unref();
    child.once("error", failure);
    child.stdin.once("error", failure);
    child.once("exit", (code) => code === 0 ? finish() : failure());
    child.stdin.end(value);
  });
}

export async function keychainRead(service: string, account: string): Promise<string> {
  try {
    const result = await execFileAsync("/usr/bin/security", ["find-generic-password", "-w", "-a", account, "-s", service], {
      maxBuffer: 16 * 1024,
    });
    const value = result.stdout.trim();
    if (!value) throw new Error("empty");
    return value;
  } catch {
    throw new Error(`Could not read Keychain service ${service}`);
  }
}

async function sendConnectionTest(appId: string, appSecret: string, openId: string): Promise<void> {
  const client = new Client({ appId, appSecret, appType: AppType.SelfBuild, domain: Domain.Feishu });
  const response = await client.im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text: "Content Lab 已連線" }),
    },
  });
  assertFeishuSuccess(response, "Feishu test message");
}

export async function onboardFeishuApp(
  input: { appId: string; account: string; sendTest?: boolean },
  overrides: Partial<OnboardDependencies> = {},
): Promise<FeishuOnboardResult> {
  if (!/^cli_[A-Za-z0-9]+$/.test(input.appId)) throw new Error("Invalid Feishu app id");
  const dependencies: OnboardDependencies = {
    register: registerApp,
    onQrCode: () => undefined,
    store: keychainStoreFromStdin,
    sendTest: sendConnectionTest,
    ...overrides,
  };
  const result = await dependencies.register({
    appId: input.appId,
    // The SDK otherwise applies its broad default app template during device
    // authorization.  Existing app permissions stay intact; this prevents the
    // onboarding flow from requesting unrelated incremental scopes/events.
    addons: { preset: false },
    onQRCodeReady: (info) => dependencies.onQrCode(info),
  });
  if (result.client_id !== input.appId) throw new Error("Registered a different Feishu app");

  await dependencies.store(FEISHU_KEYCHAIN_SERVICES.appSecret, result.client_id, result.client_secret);
  await dependencies.store(FEISHU_KEYCHAIN_SERVICES.appId, input.account, result.client_id);
  const ownerOpenId = result.user_info?.open_id;
  if (!ownerOpenId) {
    return { ok: false, appId: result.client_id, service: FEISHU_KEYCHAIN_SERVICES.appSecret, error: "owner_open_id_missing" };
  }
  await dependencies.store(FEISHU_KEYCHAIN_SERVICES.ownerOpenId, result.client_id, ownerOpenId);
  if (input.sendTest) await dependencies.sendTest(result.client_id, result.client_secret, ownerOpenId);
  return {
    ok: true,
    appId: result.client_id,
    service: FEISHU_KEYCHAIN_SERVICES.appSecret,
    ...(input.sendTest ? { testSent: true } : {}),
  };
}

import "server-only";

import { env } from "cloudflare:workers";

import type { AlertItem, PostFeature, PostSummary, Prediction, Snapshot } from "@/lib/content-lab";

type RuntimeEnv = Cloudflare.Env & Record<string, unknown>;

export function runtimeEnv(): RuntimeEnv {
  return env as RuntimeEnv;
}

export function getD1(): D1Database {
  const db = runtimeEnv().DB;
  if (!db) throw new Error("D1 binding DB is unavailable");
  return db;
}

export function jsonError(message: string, status = 400, details?: unknown): Response {
  return Response.json({ error: message, ...(details === undefined ? {} : { details }) }, { status });
}

export function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function integer(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const next = Number(value);
  return Number.isFinite(next) ? Math.trunc(next) : fallback;
}

export function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? Math.trunc(next) : null;
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function rowToPost(row: Record<string, unknown>): PostSummary {
  return {
    id: String(row.id),
    url: String(row.url),
    creatorHandle: nullableString(row.creator_handle),
    market: nullableString(row.market) ?? "VN",
    projectTag: nullableString(row.project_tag),
    postType: nullableString(row.post_type) ?? "video",
    caption: nullableString(row.caption),
    thumbnailUrl: nullableString(row.thumbnail_url),
    mediaUrl: nullableString(row.media_url),
    publishedAt: nullableString(row.published_at),
    boundAt: String(row.bound_at),
    trackingState: nullableString(row.tracking_state) ?? "active",
    analysisState: nullableString(row.analysis_state) ?? "queued",
    views: integer(row.views),
    likes: integer(row.likes),
    comments: integer(row.comments),
    shares: integer(row.shares),
    saves: integer(row.saves),
    delta24h: integer(row.delta_24h),
    lastCapturedAt: nullableString(row.last_captured_at),
    rankPosition: nullableInteger(row.rank_position),
    rankTotal: nullableInteger(row.rank_total),
    checkpoints: safeJson<PostSummary["checkpoints"]>(row.checkpoints_json, []),
    potential: ["high", "medium", "low"].includes(String(row.potential_band)) ? row.potential_band as PostSummary["potential"] : null,
    hookType: nullableString(row.hook_type),
    topic: nullableString(row.topic),
  };
}

export function rowToSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    id: String(row.id),
    capturedAt: String(row.captured_at),
    views: nullableInteger(row.views),
    viewsDelta: nullableInteger(row.views_delta),
    likes: nullableInteger(row.likes),
    comments: nullableInteger(row.comments),
    shares: nullableInteger(row.shares),
    coverage: row.coverage === "missing" || row.coverage === "interpolated" ? row.coverage : "observed",
    source: nullableString(row.source),
  };
}

export function rowToFeature(row: Record<string, unknown> | null): PostFeature | null {
  if (!row) return null;
  return {
    taxonomyVersion: nullableString(row.taxonomy_version) ?? "v3",
    tags: safeJson<Record<string, unknown>>(row.tags_json, {}),
    hookText: nullableString(row.hook_text),
    hookTranslationZh: nullableString(row.hook_translation_zh),
    transcript: nullableString(row.transcript),
    summaryZh: nullableString(row.summary_zh),
    formulaZh: nullableString(row.formula_zh),
    keyframes: safeJson<string[]>(row.keyframes_json, []),
    script: safeJson<PostFeature["script"]>(row.script_json, []),
    computed: safeJson<PostFeature["computed"]>(row.computed_json, {}),
    frames: safeJson<PostFeature["frames"]>(row.frames_json, []),
    texts: safeJson<PostFeature["texts"]>(row.texts_json, {}),
    createdAt: String(row.created_at),
  };
}

export function rowToPrediction(row: Record<string, unknown>): Prediction {
  return {
    id: String(row.id),
    stage: String(row.stage),
    madeAt: String(row.made_at),
    rankPosition: nullableInteger(row.rank_position),
    rankTotal: nullableInteger(row.rank_total),
    band: nullableString(row.band),
    rationale: nullableString(row.rationale),
    assessment: (() => {
      const inputs = safeJson<Record<string, unknown>>(row.inputs_json, {});
      return inputs.kind === "playbook_assessment" ? inputs as unknown as Prediction["assessment"] : null;
    })(),
  };
}

export function rowToAlert(row: Record<string, unknown>): AlertItem {
  return {
    id: String(row.id),
    postId: nullableString(row.post_id),
    rule: String(row.rule),
    firedAt: String(row.fired_at),
    payload: safeJson<Record<string, unknown>>(row.payload_json, {}),
  };
}

export function normalizeTikTokUrl(input: string): { url: string; videoId: string | null } {
  let candidate = input.trim();
  if (!candidate) throw new Error("链接不能为空 · Link is empty");
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  const parsed = new URL(candidate);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== "tiktok.com" && !hostname.endsWith(".tiktok.com")) {
    throw new Error("只接受 TikTok 链接 · Only TikTok links are accepted");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("链接协议不支持 · Unsupported link protocol");

  parsed.protocol = "https:";
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = hostname;
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const videoId = parsed.pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null;
  const shortLink = hostname === "vt.tiktok.com" || hostname === "vm.tiktok.com" || /^\/t\/[A-Za-z0-9]+$/.test(parsed.pathname);
  if (!videoId && !shortLink) {
    throw new Error(/^\/@[^/]+$/.test(parsed.pathname)
      ? "这是账号主页，不是帖子链接；请打开具体视频后复制链接 · This is a profile page, not a post link; open the video and copy its link"
      : "不是 TikTok 帖子链接 · Not a TikTok post link (needs /video/, /photo/ or a vt.tiktok.com short link)");
  }
  return { url: parsed.toString(), videoId };
}

export function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous";
}

export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function requireWorker(request: Request): Response | null {
  const configured = nullableString(runtimeEnv().LOCAL_WORKER_TOKEN) ?? nullableString(process.env.LOCAL_WORKER_TOKEN);
  if (!configured) return jsonError("本机 worker 尚未配对 · Local worker not paired", 503);
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || !constantTimeEqual(supplied, configured)) return jsonError("worker token 无效 · Invalid worker token", 401);
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function pick(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (payload[key] !== undefined) return payload[key];
  return undefined;
}

import { createHash } from "node:crypto";

import { expandTikTokUrl, extractVideoId, normalizeTikTokUrl } from "../domain/tiktok-url.js";
import type { MetricsProvider, PostMetadata, ProviderResult } from "./metrics.js";
import { ProviderError } from "./metrics.js";

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
};
const statusNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

class Throttle {
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAt - Date.now());
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      this.nextAt = Date.now() + this.intervalMs;
    });
    this.tail = turn.catch(() => undefined);
    await turn;
  }
}

async function fetchJson(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = 15_000): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export interface TikTokProviderOptions {
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  retries?: number;
}

export class TikTokProvider implements MetricsProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly throttle: Throttle;

  constructor(options: TikTokProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 2;
    this.throttle = new Throttle(options.minIntervalMs ?? 1_250);
  }

  async fetchPost(inputUrl: string): Promise<ProviderResult> {
    const url = await expandTikTokUrl(inputUrl, this.fetchImpl);
    try {
      return await this.fetchTikwm(url);
    } catch (primaryError) {
      try {
        const fallback = await this.fetchOEmbed(url);
        return { ...fallback, fallbackReason: primaryError instanceof Error ? primaryError.message : String(primaryError) };
      } catch (fallbackError) {
        if (primaryError instanceof ProviderError && primaryError.unavailableReason === "private_or_deleted") throw primaryError;
        throw new ProviderError("TikWM and TikTok oEmbed both failed", {
          retryable: true, unavailableReason: "upstream", cause: fallbackError,
        });
      }
    }
  }

  private async fetchTikwm(url: string): Promise<ProviderResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.throttle.wait();
      try {
        const endpoint = new URL("https://www.tikwm.com/api/");
        endpoint.searchParams.set("url", url);
        endpoint.searchParams.set("hd", "1");
        const { response, body } = await fetchJson(endpoint.toString(), { headers: { accept: "application/json", "user-agent": "ContentLab/0.1" } }, this.fetchImpl);
        const root = object(body);
        const code = statusNumber(root.code);
        if (response.status === 429 || response.status >= 500 || (code !== null && code !== 0)) {
          const message = text(root.msg) ?? `TikWM returned ${response.status}`;
          if (/private|deleted|not found|不存在/i.test(message)) {
            throw new ProviderError(message, { retryable: false, unavailableReason: "private_or_deleted" });
          }
          throw new ProviderError(message, { retryable: true, unavailableReason: response.status === 429 ? "rate_limited" : "upstream" });
        }
        if (!response.ok) throw new ProviderError(`TikWM returned ${response.status}`, { retryable: response.status >= 500, unavailableReason: "upstream" });
        const data = object(root.data);
        const author = object(data.author);
        const music = object(data.music_info);
        const videoId = text(data.id) ?? extractVideoId(url);
        if (!videoId) throw new ProviderError("TikWM response is missing a video id", { retryable: true, unavailableReason: "invalid_response" });
        const metrics = {
          views: number(data.play_count), likes: number(data.digg_count), comments: number(data.comment_count), shares: number(data.share_count), saves: number(data.collect_count),
        };
        if (metrics.views === null || metrics.likes === null || metrics.comments === null || metrics.shares === null) {
          throw new ProviderError("TikWM response is missing metrics", { retryable: true, unavailableReason: "invalid_response" });
        }
        const createTime = number(data.create_time);
        const images = Array.isArray(data.images) ? data.images : [];
        const isPhoto = images.length > 0;
        return {
          source: "tikwm",
          metadata: {
            videoId, url: normalizeTikTokUrl(url), authorId: text(author.id), authorHandle: text(author.unique_id) ?? text(author.nickname) ?? "unknown",
            caption: text(data.title) ?? "", type: isPhoto ? "photo" : "video", durationS: number(data.duration),
            musicTitle: text(music.title), coverUrl: text(data.cover), mediaUrl: isPhoto ? text(images[0]) : text(data.hdplay) ?? text(data.play) ?? text(data.wmplay),
            publishedAt: createTime === null ? null : new Date(createTime * 1_000).toISOString(),
          },
          metrics: { views: metrics.views, likes: metrics.likes, comments: metrics.comments, shares: metrics.shares, saves: metrics.saves },
        };
      } catch (error) {
        if (error instanceof ProviderError && !error.retryable) throw error;
        lastError = error;
        if (attempt < this.retries) await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    if (lastError instanceof ProviderError) throw lastError;
    throw new ProviderError("TikWM request failed", { retryable: true, unavailableReason: "upstream", cause: lastError });
  }

  private async fetchOEmbed(url: string): Promise<ProviderResult> {
    const endpoint = new URL("https://www.tiktok.com/oembed");
    endpoint.searchParams.set("url", url);
    const { response, body } = await fetchJson(endpoint.toString(), { headers: { accept: "application/json", "user-agent": "ContentLab/0.1" } }, this.fetchImpl);
    if (!response.ok) {
      const terminal = response.status === 404;
      throw new ProviderError(`TikTok oEmbed returned ${response.status}`, { retryable: !terminal, unavailableReason: terminal ? "private_or_deleted" : "upstream" });
    }
    const data = object(body);
    const videoId = extractVideoId(url) ?? text(data.embed_product_id) ?? `url-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
    const metadata: PostMetadata = {
      videoId, url: normalizeTikTokUrl(url), authorId: null, authorHandle: text(data.author_unique_id) ?? text(data.author_name) ?? "unknown",
      caption: text(data.title) ?? "", type: "video", durationS: null, musicTitle: null,
      coverUrl: text(data.thumbnail_url), mediaUrl: null, publishedAt: null,
    };
    return { source: "tiktok_oembed", metadata, metrics: null };
  }
}

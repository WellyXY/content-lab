export interface PostMetadata {
  videoId: string;
  url: string;
  authorId: string | null;
  authorHandle: string;
  caption: string;
  type: "video" | "photo";
  durationS: number | null;
  musicTitle: string | null;
  /** Signed, short-lived link to the post's sound; used right away, never stored. */
  musicUrl?: string | null;
  coverUrl: string | null;
  mediaUrl: string | null;
  /** Every image of a photo carousel, in order; empty for videos. */
  imageUrls: string[];
  publishedAt: string | null;
}

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number | null;
}

export interface ProviderResult {
  metadata: PostMetadata;
  metrics: PostMetrics | null;
  source: "tikwm" | "tiktok_oembed";
  fallbackReason?: string;
}

export interface MetricsProvider {
  fetchPost(url: string): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  /** "likely_removed": no source can see the post any more (private, under review or deleted), but one failed check is not proof. */
  readonly unavailableReason: "private_or_deleted" | "likely_removed" | "rate_limited" | "upstream" | "invalid_response";

  constructor(message: string, options: { retryable: boolean; unavailableReason: ProviderError["unavailableReason"]; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.retryable = options.retryable;
    this.unavailableReason = options.unavailableReason;
  }
}

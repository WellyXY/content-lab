import type { MarketAds } from "@/lib/ads";

/** Markets a post can be bound to; the label shows the timezone used for day boundaries. */
export const MARKETS = [
  { code: "ID", label: "印尼", labelEn: "Indonesia", timezone: "UTC+7" },
  { code: "VN", label: "越南", labelEn: "Vietnam", timezone: "UTC+7" },
  { code: "TR", label: "土耳其", labelEn: "Türkiye", timezone: "UTC+3" },
  { code: "GCC", label: "海湾地区", labelEn: "GCC", timezone: "UTC+3" },
  { code: "TH", label: "泰国", labelEn: "Thailand", timezone: "UTC+7" },
  { code: "IQ", label: "伊拉克", labelEn: "Iraq", timezone: "UTC+3" },
  { code: "PH", label: "菲律宾", labelEn: "Philippines", timezone: "UTC+8" },
] as const;
export type MarketCode = (typeof MARKETS)[number]["code"];
export const MARKET_CODES = MARKETS.map((market) => market.code) as [MarketCode, ...MarketCode[]];
export const marketLabel = (code: string, lang: "zh" | "en" = "zh"): string => { const market = MARKETS.find((item) => item.code === code); return market ? (lang === "zh" ? market.label : market.labelEn) : code; };

export type WorkerStatus = {
  connected: boolean;
  lastSeenAt: string | null;
  queueDepth: number;
};

export type AdsTotals = { spend: number; impressions: number; clicks: number; installs: number; registrations: number; cpr: number | null; cpi: number | null; cpm: number | null; ctr: number | null };
/** Spark Ads delivery summed over every ad that promotes the post (USD); null when never promoted. */
export type PostAds = {
  status: "active" | "inactive";
  adCount: number; accounts: number;
  lifetime: AdsTotals; last7d: AdsTotals; prev7d: AdsTotals;
  daily: Array<{ date: string; spend: number; registrations: number; installs: number }>;
  topAds: Array<{ adId: string; adName: string | null; campaignName: string | null; advertiserName: string | null } & AdsTotals>;
  refreshedAt: string | null;
  currencyExcluded: number;
};

export type PostSummary = {
  id: string;
  url: string;
  creatorHandle: string | null;
  market: string;
  projectTag: string | null;
  postType: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
  boundAt: string;
  trackingState: string;
  analysisState: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  delta24h: number;
  lastCapturedAt: string | null;
  rankPosition?: number | null;
  rankTotal?: number | null;
  /** Early performance at 1/3/6/24/72 hours after publishing, computed by the worker. */
  checkpoints?: Checkpoint[];
  /** Viral potential from the latest playbook assessment (v1, views only). */
  potential?: "high" | "medium" | "low" | null;
  /** Knowledge base v2 scores, 0–10, made blind to the post's own performance; null when evidence was missing. */
  creativeScore?: number | null;
  registrationPotential?: number | null;
  hookType?: string | null;
  topic?: string | null;
  ads?: PostAds | null;
};

export type Checkpoint = {
  hours: number;
  status: "recorded" | "missed" | "pending";
  capturedAt: string | null;
  ageHours: number | null;
  views: number | null;
  viewsPerHour: number | null;
  likeRate: number | null;
  commentRate: number | null;
  shareRate: number | null;
  saveRate: number | null;
};

export type Snapshot = {
  id: string;
  capturedAt: string;
  views: number | null;
  viewsDelta: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  coverage: "observed" | "interpolated" | "missing";
  source: string | null;
};

export type PostFeature = {
  taxonomyVersion: string;
  tags: Record<string, unknown>;
  hookText: string | null;
  hookTranslationZh: string | null;
  transcript: string | null;
  summaryZh: string | null;
  formulaZh: string | null;
  keyframes: string[];
  script: ScriptSegment[];
  computed: ComputedFeatures;
  frames: Array<{ frame: number; timeS: number | null; imageIndex: number | null }>;
  /** Bilingual Agent texts: hook_translation_zh/_en, summary_zh/_en, formula_zh/_en. */
  texts: Record<string, string>;
  createdAt: string;
};

export type ScriptSegment = {
  position: string;
  start_s: number;
  end_s: number;
  role: "hook" | "setup" | "development" | "turn" | "payoff" | "cta" | "other";
  frames: number[];
  visual_zh: string; visual_en?: string;
  on_screen_text: string;
  on_screen_text_zh: string; on_screen_text_en?: string;
  spoken: string;
  spoken_zh: string; spoken_en?: string;
};

/** Program-computed facts; every field may be missing on analyses made before they existed. */
export type ComputedFeatures = Partial<{
  format_type: "video" | "photo"; duration_s: number | null; duration_band: string | null; scene_cuts: number | null;
  cuts_per_10s: number | null; pacing_band: "slow" | "medium" | "fast" | null; image_count: number | null;
  has_speech: boolean; speech_words: number; speech_words_per_min: number | null; first_speech_s: number | null;
  speech_coverage: number | null; music_type: "original" | "library" | "unknown"; on_screen_text_chars: number;
  on_screen_text_per_frame: number | null; caption_chars: number; hashtag_count: number; brand_in_caption: boolean;
  publish_hour_local: number | null; publish_weekday_local: number | null;
}>;

export type PlaybookAssessment = {
  kind: "playbook_assessment";
  playbook: { id: string; market: string; version: number; weekStart: string } | null;
  inSample?: string | null;
  potential?: "high" | "medium" | "low";
  potential_reason_zh?: string; potential_reason_en?: string;
  matched_patterns?: Array<{ pattern_id: string; evidence_zh: string; evidence_en?: string }>;
  anti_patterns_hit?: Array<{ pattern_id: string; evidence_zh: string; evidence_en?: string }>;
  missing_patterns?: Array<{ pattern_id: string; gap_zh: string; gap_en?: string }>;
  suggestions?: Array<{ priority: 1 | 2 | 3; change_zh: string; change_en?: string; reason_zh: string; reason_en?: string; pattern_ids: string[] }>;
  similar_post_ids?: string[];
};

/** Agent text arrives as `_zh` (Simplified Chinese) and `_en`; playbooks from before the bilingual format only have `_zh`. */
export type PlaybookPattern = {
  id: string; title_zh: string; title_en?: string; description_zh: string; description_en?: string;
  why_it_works_zh?: string; why_it_works_en?: string; how_to_apply_zh?: string; how_to_apply_en?: string;
  stat_keys: string[]; example_post_ids: string[];
};

export type PlaybookSummary = { id: string; market: string; version: number; weekStart: string; createdAt: string };

export type PlaybookData = PlaybookSummary & {
  model: string | null;
  markdown: string;
  document: {
    summary_zh: string; summary_en?: string;
    patterns: PlaybookPattern[];
    anti_patterns: PlaybookPattern[];
    weekly_changes: Array<{ type: string; pattern_id: string; change_zh: string; change_en?: string }>;
    open_questions?: Array<{ zh: string; en: string }>;
    open_questions_zh?: string[];
    exceptions?: Array<{ kind: "high_views_low_registrations" | "low_views_good_registrations" | "copy_failed" | "other"; zh: string; en: string; post_ids: string[] }>;
    sample_caveat_zh: string; sample_caveat_en?: string;
  };
  evidence: {
    /** "registrations" ranks promoted posts by cost per registration within format; missing means views. */
    outcome?: "views" | "registrations";
    eligiblePosts: number; topSize: number; bottomSize: number; topMinViews: number; medianViews: number;
    topMaxCpr?: number; medianCpr?: number; insufficientPosts?: number;
    stats: Array<{ key: string; label: string; labelEn?: string; posts: number; topPosts: number; bottomPosts: number; topShare: number; bottomShare: number; lift: number; medianViews: number; medianCpr?: number | null }>;
    numeric: Array<{ key: string; label: string; labelEn?: string; topMedian: number | null; bottomMedian: number | null }>;
    posts: Array<{ id: string; views: number; tier: string; summaryZh: string; summaryEn?: string; formulaZh: string; formulaEn?: string; cpr?: number; registrations?: number }>;
  };
};

type Bi<K extends string> = { [P in `${K}_zh` | `${K}_en`]: string };
export type EvaluationScore = { score: number | null; confidence: "low" | "medium" | "high"; evidence: Array<{ label: string; zh: string; en: string }> } & Bi<"caveat">;
/** Knowledge base v2 evaluation (docs/kb): two independent blind scores, motivation analysis and script changes. */
export type KbEvaluation = {
  kind: "kb_evaluation"; kbVersion: string; promptVersion: string;
  creativeScore: number | null; registrationPotential: number | null;
  source_status: "complete" | "partial" | "unavailable";
  creative_score: EvaluationScore; registration_potential: EvaluationScore;
  hook: { triggers: string[]; forms: string[]; zh: string; en: string };
  reverse: { present: boolean; position: string; links_to_motivation: boolean } & Bi<"setup" | "reveal">;
  product_integration: { visibility: "none" | "brief" | "central" } & Bi<"narrative_function" | "motivation_connection">;
  motivation: Bi<"desire" | "why_popup" | "first_person_thought" | "plausibility" | "timing" | "entertainment_gap">;
  diagnosis: { strengths: Array<{ zh: string; en: string }>; barriers: Array<{ zh: string; en: string }> } & Bi<"exceptions">;
  recommendations: Array<Bi<"change" | "mechanism" | "hypothesis"> & { reference_case_ids: string[] }>;
  references?: Array<{ id: string; postId: string }>;
} & Bi<"summary" | "evidence_limitations" | "payoff" | "trend_localization">;

export type Prediction = {
  id: string;
  stage: string;
  madeAt: string;
  rankPosition: number | null;
  rankTotal: number | null;
  band: string | null;
  rationale: string | null;
  assessment: PlaybookAssessment | null;
  evaluation?: KbEvaluation | null;
};

export type AlertItem = {
  id: string;
  postId: string | null;
  rule: string;
  firedAt: string;
  payload: Record<string, unknown>;
};

export type DashboardData = {
  mode: "live";
  generatedAt: string;
  worker: WorkerStatus;
  totals: {
    views7d: number;
    viewsPrevious7d: number;
    activePosts: number;
    millionPostsThisWeek: number;
    queuedJobs: number;
    runningJobs: number;
    captureSuccessRate24h: number | null;
  };
  trend: Array<{ at: string; views: number }>;
  movers: PostSummary[];
  recentAlerts: AlertItem[];
  marketBreakdown: Array<{ market: string; views: number; posts: number }>;
  /** Spark Ads delivery per market, last 7 days vs the 7 before (absent on an older worker). */
  adsByMarket?: MarketAds[];
  /** Posts with the most registrations in the last 7 days. */
  topRegistrationPosts?: PostSummary[];
};

export type Recreation = {
  id: string;
  /** "recreate": motion-graphics re-edit; "copy": a carousel reshot with a new creator. */
  kind: "recreate" | "copy";
  status: "queued" | "preparing" | "designing" | "rendering" | "complete" | "failed";
  notes: {
    summary_zh: string; summary_en: string; changes: Array<{ zh: string; en: string; suggestion: string | null }>; skipped?: Array<{ zh: string; en: string; suggestion: string | null }>;
    /** Carousel copies: per image the original and the generated versions; screenshots are kept. */
    images?: Array<{ index: number; kept: boolean; original: string; variants: string[]; failed: number }>;
  } | null;
  videoUrl: string | null;
  coverUrl: string | null;
  error: string | null;
  /** 0 when the attempt does not count against the per-post limit. */
  counts: number;
  createdAt: string;
  updatedAt: string;
};

export type PostDetailData = {
  recreations?: Recreation[];
  keyframes?: string[];
  mediaError?: string | null;
  post: PostSummary;
  snapshots: Snapshot[];
  features: PostFeature | null;
  predictions: Prediction[];
  alerts: AlertItem[];
};

export const emptyDashboard: DashboardData = {
  mode: "live", generatedAt: "", worker: { connected: false, lastSeenAt: null, queueDepth: 0 },
  totals: { views7d: 0, viewsPrevious7d: 0, activePosts: 0, millionPostsThisWeek: 0, queuedJobs: 0, runningJobs: 0, captureSuccessRate24h: null },
  trend: [], movers: [], recentAlerts: [], marketBreakdown: [],
};

export function compactNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: value >= 1_000_000 ? 2 : 1 }).format(value);
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export function timeAgo(value: string | null, referenceTime = Date.now(), lang: "zh" | "en" = "zh"): string {
  const zh = lang === "zh";
  if (!value) return zh ? "尚未同步" : "Not synced yet";
  const diff = Math.max(0, referenceTime - new Date(value).getTime());
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return zh ? "刚刚" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return zh ? `${days} 天前` : `${days} d ago`;
}

export { tagLabel, tagDimensionLabel, tagConfidenceLabel } from "./tag-labels";

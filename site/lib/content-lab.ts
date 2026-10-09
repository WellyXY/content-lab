/** Markets a post can be bound to; the label shows the timezone used for day boundaries. */
export const MARKETS = [
  { code: "ID", label: "印尼", timezone: "UTC+7" },
  { code: "VN", label: "越南", timezone: "UTC+7" },
  { code: "TR", label: "土耳其", timezone: "UTC+3" },
  { code: "GCC", label: "海灣地區", timezone: "UTC+3" },
  { code: "TH", label: "泰國", timezone: "UTC+7" },
] as const;
export type MarketCode = (typeof MARKETS)[number]["code"];
export const MARKET_CODES = MARKETS.map((market) => market.code) as [MarketCode, ...MarketCode[]];
export const marketLabel = (code: string): string => MARKETS.find((market) => market.code === code)?.label ?? code;

export type WorkerStatus = {
  connected: boolean;
  lastSeenAt: string | null;
  queueDepth: number;
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
  hookType?: string | null;
  topic?: string | null;
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
  createdAt: string;
};

export type ScriptSegment = {
  position: string;
  start_s: number;
  end_s: number;
  role: "hook" | "setup" | "development" | "turn" | "payoff" | "cta" | "other";
  frames: number[];
  visual_zh: string;
  on_screen_text: string;
  on_screen_text_zh: string;
  spoken: string;
  spoken_zh: string;
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
  potential_reason_zh?: string;
  matched_patterns?: Array<{ pattern_id: string; evidence_zh: string }>;
  anti_patterns_hit?: Array<{ pattern_id: string; evidence_zh: string }>;
  missing_patterns?: Array<{ pattern_id: string; gap_zh: string }>;
  suggestions?: Array<{ priority: 1 | 2 | 3; change_zh: string; reason_zh: string; pattern_ids: string[] }>;
  similar_post_ids?: string[];
};

export type PlaybookPattern = { id: string; title_zh: string; description_zh: string; why_it_works_zh?: string; how_to_apply_zh?: string; stat_keys: string[]; example_post_ids: string[] };

export type PlaybookSummary = { id: string; market: string; version: number; weekStart: string; createdAt: string };

export type PlaybookData = PlaybookSummary & {
  model: string | null;
  markdown: string;
  document: {
    summary_zh: string;
    patterns: PlaybookPattern[];
    anti_patterns: PlaybookPattern[];
    weekly_changes: Array<{ type: string; pattern_id: string; change_zh: string }>;
    open_questions_zh: string[];
    sample_caveat_zh: string;
  };
  evidence: {
    eligiblePosts: number; topSize: number; bottomSize: number; topMinViews: number; medianViews: number;
    stats: Array<{ key: string; label: string; posts: number; topPosts: number; bottomPosts: number; topShare: number; bottomShare: number; lift: number; medianViews: number }>;
    numeric: Array<{ key: string; label: string; topMedian: number | null; bottomMedian: number | null }>;
    posts: Array<{ id: string; views: number; tier: string; summaryZh: string; formulaZh: string }>;
  };
};

export type Prediction = {
  id: string;
  stage: string;
  madeAt: string;
  rankPosition: number | null;
  rankTotal: number | null;
  band: string | null;
  rationale: string | null;
  assessment: PlaybookAssessment | null;
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
};

export type PostDetailData = {
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

export function timeAgo(value: string | null, referenceTime = Date.now()): string {
  if (!value) return "尚未同步";
  const diff = Math.max(0, referenceTime - new Date(value).getTime());
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.round(hours / 24)} 天前`;
}

export { tagLabel, tagDimensionLabel, tagConfidenceLabel } from "./tag-labels";

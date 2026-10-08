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
  createdAt: string;
};

export type Prediction = {
  id: string;
  stage: string;
  madeAt: string;
  rankPosition: number | null;
  rankTotal: number | null;
  band: string | null;
  rationale: string | null;
};

export type AlertItem = {
  id: string;
  postId: string | null;
  rule: string;
  firedAt: string;
  payload: Record<string, unknown>;
};

export type DashboardData = {
  mode: "live" | "demo";
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
  post: PostSummary;
  snapshots: Snapshot[];
  features: PostFeature | null;
  predictions: Prediction[];
  alerts: AlertItem[];
};

// Keep the server and browser's first render identical. API handlers shift
// these fixtures to their request time through the helpers below.
const DEMO_ANCHOR = Date.UTC(2026, 9, 8, 21, 0, 0);
const hoursAgo = (hours: number) => new Date(DEMO_ANCHOR - hours * 3_600_000).toISOString();

export const demoPosts: PostSummary[] = [
  {
    id: "demo-minhngoc",
    url: "https://www.tiktok.com/@minhngoc.daily/video/7000000000000000001",
    creatorHandle: "@minhngoc.daily",
    market: "VN",
    projectTag: "Fate Radar",
    postType: "video",
    caption: "POV: người ấy cũng đang chờ tin nhắn của bạn",
    thumbnailUrl: null,
    publishedAt: hoursAgo(33),
    boundAt: hoursAgo(32),
    trackingState: "active",
    analysisState: "complete",
    views: 2_436_000,
    likes: 184_300,
    comments: 8_420,
    shares: 36_850,
    saves: 11_200,
    delta24h: 284_200,
    lastCapturedAt: hoursAgo(0.2),
    rankPosition: 1,
    rankTotal: 18,
    hookType: "relatable_pain",
    topic: "crush_ambiguity",
  },
  {
    id: "demo-deniz",
    url: "https://www.tiktok.com/@deniz.oz/video/7000000000000000002",
    creatorHandle: "@deniz.oz",
    market: "TR",
    projectTag: "PopUp TR",
    postType: "video",
    caption: "Mesajı gördü ama cevap vermediğinde...",
    thumbnailUrl: null,
    publishedAt: hoursAgo(56),
    boundAt: hoursAgo(55),
    trackingState: "active",
    analysisState: "complete",
    views: 1_124_000,
    likes: 92_100,
    comments: 5_420,
    shares: 18_640,
    saves: 6_830,
    delta24h: 197_400,
    lastCapturedAt: hoursAgo(0.35),
    rankPosition: 2,
    rankTotal: 11,
    hookType: "result_first",
    topic: "trust_jealousy",
  },
  {
    id: "demo-linh",
    url: "https://www.tiktok.com/@linh.loves/video/7000000000000000003",
    creatorHandle: "@linh.loves",
    market: "VN",
    projectTag: "Always-on",
    postType: "photo",
    caption: "5 dấu hiệu người ấy thích bạn",
    thumbnailUrl: null,
    publishedAt: hoursAgo(18),
    boundAt: hoursAgo(17),
    trackingState: "active",
    analysisState: "complete",
    views: 884_100,
    likes: 71_430,
    comments: 3_750,
    shares: 22_140,
    saves: 19_660,
    delta24h: 142_800,
    lastCapturedAt: hoursAgo(0.15),
    rankPosition: 3,
    rankTotal: 18,
    hookType: "identity_callout",
    topic: "flirting_skill",
  },
  {
    id: "demo-anh",
    url: "https://www.tiktok.com/@anhthu/video/7000000000000000004",
    creatorHandle: "@anhthu",
    market: "VN",
    projectTag: "Fate Radar",
    postType: "video",
    caption: "Một cuộc gặp không hề tình cờ",
    thumbnailUrl: null,
    publishedAt: hoursAgo(72),
    boundAt: hoursAgo(70),
    trackingState: "slow",
    analysisState: "complete",
    views: 524_700,
    likes: 40_200,
    comments: 2_110,
    shares: 8_760,
    saves: 4_220,
    delta24h: 61_200,
    lastCapturedAt: hoursAgo(1.1),
    rankPosition: 7,
    rankTotal: 18,
    hookType: "suspense",
    topic: "dating_meetup",
  },
  {
    id: "demo-mert",
    url: "https://www.tiktok.com/@mertaks/video/7000000000000000005",
    creatorHandle: "@mertaks",
    market: "TR",
    projectTag: "PopUp TR",
    postType: "video",
    caption: "Tek başına kalmaktan sıkıldıysan",
    thumbnailUrl: null,
    publishedAt: hoursAgo(8),
    boundAt: hoursAgo(7.5),
    trackingState: "active",
    analysisState: "processing",
    views: 91_800,
    likes: 8_600,
    comments: 920,
    shares: 1_740,
    saves: 780,
    delta24h: 91_800,
    lastCapturedAt: hoursAgo(0.4),
    rankPosition: 4,
    rankTotal: 11,
    hookType: "identity_callout",
    topic: "singlehood",
  },
];

export const demoDashboard: DashboardData = {
  mode: "demo",
  generatedAt: new Date(DEMO_ANCHOR).toISOString(),
  worker: { connected: false, lastSeenAt: null, queueDepth: 9 },
  totals: {
    views7d: 8_420_000,
    viewsPrevious7d: 7_100_000,
    activePosts: 184,
    millionPostsThisWeek: 6,
    queuedJobs: 9,
    runningJobs: 3,
    captureSuccessRate24h: 96.8,
  },
  trend: [36, 52, 44, 66, 58, 74, 61, 82, 69, 91, 76, 88, 72, 96].map((value, index) => ({
    at: hoursAgo((13 - index) * 12),
    views: value * 7_600,
  })),
  movers: demoPosts.slice(0, 3),
  recentAlerts: [
    {
      id: "demo-alert",
      postId: "demo-minhngoc",
      rule: "milestone_1m",
      firedAt: hoursAgo(0.18),
      payload: { creatorHandle: "@minhngoc.daily", currentViews: 1_024_000, delta: 84_200, multiplier: 3.7 },
    },
  ],
  marketBreakdown: [
    { market: "VN", views: 6_740_000, posts: 138 },
    { market: "TR", views: 1_680_000, posts: 46 },
  ],
};

export const demoDetail: PostDetailData = {
  post: demoPosts[0],
  snapshots: Array.from({ length: 36 }, (_, index) => {
    const missing = index === 9 || index === 10;
    const views = Math.round(18_000 * Math.pow(index + 1, 1.38));
    return {
      id: `demo-snapshot-${index}`,
      capturedAt: hoursAgo(35 - index),
      views: missing ? null : views,
      viewsDelta: missing ? null : Math.max(0, index === 0 ? views : views - Math.round(18_000 * Math.pow(index, 1.38))),
      likes: missing ? null : Math.round(views * 0.074),
      comments: missing ? null : Math.round(views * 0.0034),
      shares: missing ? null : Math.round(views * 0.015),
      coverage: missing ? "missing" : index === 11 ? "interpolated" : "observed",
      source: missing ? null : "tikwm",
    };
  }),
  features: {
    taxonomyVersion: "v3",
    tags: {
      format: { value: "skit_pov", confidence: "high" },
      hook_type: { value: "relatable_pain", confidence: "high" },
      topic: { value: "crush_ambiguity", confidence: "high" },
      emotional_tone: { value: "relatable", confidence: "medium" },
      share_trigger: { value: "tag_someone", confidence: "high" },
      product_role: { value: "enabler", confidence: "medium" },
    },
    hookText: "Khi cả hai đều chờ người kia nhắn trước",
    hookTranslationZh: "當兩個人都在等對方先傳訊息",
    transcript: null,
    summaryZh: "用雙視角情境短劇呈現曖昧雙方都不敢先開口，最後由 PopUp 的互動功能推動破冰。",
    formulaZh: "共同痛點開場 → 雙方視角對照 → App 成為破冰動作 → 甜蜜收尾",
    keyframes: [],
    createdAt: hoursAgo(31),
  },
  predictions: [
    { id: "demo-prediction", stage: "bind", madeAt: hoursAgo(31), rankPosition: 1, rankTotal: 18, band: "top", rationale: "痛點普遍、雙視角清楚，且產品出現自然。" },
  ],
  alerts: demoDashboard.recentAlerts,
};

function shiftDemoTime(value: string | null, referenceTime: number): string | null {
  if (!value) return null;
  return new Date(referenceTime - (DEMO_ANCHOR - new Date(value).getTime())).toISOString();
}

export function createDemoPosts(referenceTime = Date.now()): PostSummary[] {
  return demoPosts.map((post) => ({
    ...post,
    publishedAt: shiftDemoTime(post.publishedAt, referenceTime),
    boundAt: shiftDemoTime(post.boundAt, referenceTime)!,
    lastCapturedAt: shiftDemoTime(post.lastCapturedAt, referenceTime),
  }));
}

export function createDemoDashboard(referenceTime = Date.now()): DashboardData {
  const posts = createDemoPosts(referenceTime);
  const postsById = new Map(posts.map((post) => [post.id, post]));
  return {
    ...demoDashboard,
    generatedAt: new Date(referenceTime).toISOString(),
    trend: demoDashboard.trend.map((point) => ({ ...point, at: shiftDemoTime(point.at, referenceTime)! })),
    movers: demoDashboard.movers.map((post) => postsById.get(post.id) ?? post),
    recentAlerts: demoDashboard.recentAlerts.map((alert) => ({ ...alert, firedAt: shiftDemoTime(alert.firedAt, referenceTime)! })),
  };
}

export function createDemoDetail(referenceTime = Date.now()): PostDetailData {
  const posts = createDemoPosts(referenceTime);
  return {
    ...demoDetail,
    post: posts[0]!,
    snapshots: demoDetail.snapshots.map((snapshot) => ({ ...snapshot, capturedAt: shiftDemoTime(snapshot.capturedAt, referenceTime)! })),
    features: demoDetail.features ? { ...demoDetail.features, createdAt: shiftDemoTime(demoDetail.features.createdAt, referenceTime)! } : null,
    predictions: demoDetail.predictions.map((prediction) => ({ ...prediction, madeAt: shiftDemoTime(prediction.madeAt, referenceTime)! })),
    alerts: createDemoDashboard(referenceTime).recentAlerts,
  };
}

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

export function tagLabel(value: string): string {
  return value.replaceAll("_", " ");
}

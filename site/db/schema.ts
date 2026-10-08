import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id"),
    url: text("url").notNull(),
    creatorHandle: text("creator_handle"),
    market: text("market").notNull().default("VN"),
    projectTag: text("project_tag"),
    postType: text("post_type").notNull().default("video"),
    caption: text("caption"),
    musicTitle: text("music_title"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: text("published_at"),
    boundAt: text("bound_at").notNull(),
    trackingState: text("tracking_state").notNull().default("active"),
    analysisState: text("analysis_state").notNull().default("queued"),
    nextCaptureAt: text("next_capture_at"),
    views: integer("views").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    saves: integer("saves").notNull().default(0),
    delta24h: integer("delta_24h").notNull().default(0),
    source: text("source"),
    lastCapturedAt: text("last_captured_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_posts_url").on(table.url),
    uniqueIndex("idx_posts_video_id").on(table.videoId),
    index("idx_posts_market_state").on(table.market, table.trackingState),
    index("idx_posts_bound_at").on(table.boundAt),
  ],
);

export const metricSnapshots = sqliteTable(
  "metric_snapshots",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull(),
    capturedAt: text("captured_at").notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    viewsDelta: integer("views_delta"),
    coverage: text("coverage").notNull().default("observed"),
    source: text("source"),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("idx_snapshots_post_captured").on(table.postId, table.capturedAt),
    index("idx_snapshots_captured_at").on(table.capturedAt),
  ],
);

export const postFeatures = sqliteTable("post_features", {
  postId: text("post_id").primaryKey(),
  version: text("version").notNull(),
  model: text("model"),
  taxonomyVersion: text("taxonomy_version").notNull().default("v3"),
  tagsJson: text("tags_json").notNull().default("{}"),
  hookText: text("hook_text"),
  hookTranslationZh: text("hook_translation_zh"),
  transcript: text("transcript"),
  summaryZh: text("summary_zh"),
  formulaZh: text("formula_zh"),
  keyframesJson: text("keyframes_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
});

export const predictions = sqliteTable(
  "predictions",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull(),
    stage: text("stage").notNull(),
    madeAt: text("made_at").notNull(),
    rankPosition: integer("rank_position"),
    rankTotal: integer("rank_total"),
    band: text("band"),
    rationale: text("rationale"),
    inputsJson: text("inputs_json").notNull().default("{}"),
  },
  (table) => [index("idx_predictions_post_made_at").on(table.postId, table.madeAt)],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    postId: text("post_id"),
    rule: text("rule").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    firedAt: text("fired_at").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    deliveredAt: text("delivered_at"),
    deliveryError: text("delivery_error"),
  },
  (table) => [
    uniqueIndex("idx_alerts_dedupe_key").on(table.dedupeKey),
    index("idx_alerts_fired_at").on(table.firedAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("queued"),
    runAt: text("run_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    lockedUntil: text("locked_until"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_jobs_ready").on(table.status, table.runAt, table.lockedUntil),
    index("idx_jobs_created_at").on(table.createdAt),
  ],
);

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  version: text("version"),
  status: text("status").notNull().default("online"),
  queueDepth: integer("queue_depth").notNull().default(0),
  lastSeenAt: text("last_seen_at").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
});

export const syncEvents = sqliteTable("sync_events", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull(),
  eventType: text("event_type").notNull(),
  entityKey: text("entity_key").notNull(),
  occurredAt: text("occurred_at").notNull(),
  acceptedAt: text("accepted_at").notNull(),
});

export const postAliases = sqliteTable(
  "post_aliases",
  {
    sourceKey: text("source_key").primaryKey(),
    postId: text("post_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_post_aliases_post_id").on(table.postId)],
);

export const ingestRateLimits = sqliteTable("ingest_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
});

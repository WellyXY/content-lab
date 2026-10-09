import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `
  CREATE TABLE creators (
    id TEXT PRIMARY KEY, handle TEXT NOT NULL, platform_user_id TEXT,
    market TEXT, tier TEXT, notes TEXT, created_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX creators_platform_uid ON creators(platform_user_id) WHERE platform_user_id IS NOT NULL;

  CREATE TABLE posts (
    id TEXT PRIMARY KEY, video_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
    creator_id TEXT REFERENCES creators(id), market TEXT, market_inferred INTEGER NOT NULL DEFAULT 0,
    project_tag TEXT, type TEXT CHECK(type IN ('video','photo')), duration_s REAL,
    caption TEXT, music_title TEXT, cover_url TEXT, media_url TEXT,
    published_at TEXT, bound_at TEXT NOT NULL, bound_by TEXT,
    tracking_state TEXT NOT NULL DEFAULT 'active' CHECK(tracking_state IN ('active','slow','daily','stopped')),
    stop_reason TEXT, next_capture_at TEXT, capture_failures INTEGER NOT NULL DEFAULT 0,
    features_state TEXT NOT NULL DEFAULT 'pending' CHECK(features_state IN ('pending','ready','features_failed')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX posts_due ON posts(tracking_state, next_capture_at);
  CREATE INDEX posts_market ON posts(market);

  CREATE TABLE metric_snapshots (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL, hour_bucket TEXT NOT NULL,
    views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
    source TEXT NOT NULL, ok INTEGER NOT NULL CHECK(ok IN (0,1)), error TEXT,
    created_at TEXT NOT NULL, UNIQUE(post_id, hour_bucket)
  ) STRICT;
  CREATE INDEX snapshots_post_time ON metric_snapshots(post_id, captured_at);

  CREATE TABLE post_hourly (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, hour_bucket TEXT NOT NULL,
    views_cum INTEGER, views_delta INTEGER, likes_delta INTEGER, comments_delta INTEGER,
    shares_delta INTEGER, saves_delta INTEGER,
    coverage TEXT NOT NULL CHECK(coverage IN ('observed','interpolated','missing')),
    PRIMARY KEY(post_id, hour_bucket)
  ) STRICT;
  CREATE INDEX hourly_bucket ON post_hourly(hour_bucket);

  CREATE TABLE post_features (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, version INTEGER NOT NULL,
    model TEXT NOT NULL, taxonomy_version TEXT NOT NULL, tags_json TEXT NOT NULL,
    hook_text TEXT, transcript TEXT, summary_zh TEXT, keyframes_json TEXT NOT NULL,
    analysis_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(post_id, version)
  ) STRICT;

  CREATE TABLE predictions (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK(stage IN ('bind','h1','h3','h6','h24')),
    made_at TEXT NOT NULL, rank_value INTEGER, cohort_size INTEGER, band TEXT,
    model_version TEXT NOT NULL, rationale TEXT NOT NULL, inputs_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX predictions_post_time ON predictions(post_id, made_at);

  CREATE TABLE alerts (
    id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
    rule TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, fired_at TEXT NOT NULL,
    payload_json TEXT NOT NULL, delivered_at TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_delivery_at TEXT, delivery_error TEXT
  ) STRICT;
  CREATE INDEX alerts_outbox ON alerts(delivered_at, next_delivery_at);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','dead')),
    run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    locked_until TEXT, lease_owner TEXT, last_error TEXT, idempotency_key TEXT UNIQUE,
    sync_remote_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
  ) STRICT;
  CREATE INDEX jobs_due ON jobs(status, run_at, locked_until);

  CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE scheduler_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sync_outbox (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT,
    UNIQUE(type, entity_key)
  ) STRICT;
  CREATE INDEX sync_outbox_due ON sync_outbox(next_attempt_at);
  `,
  `
  ALTER TABLE posts ADD COLUMN site_post_id TEXT;
  CREATE UNIQUE INDEX posts_site_post_id ON posts(site_post_id) WHERE site_post_id IS NOT NULL;
  `,
  `
  ALTER TABLE posts ADD COLUMN image_urls_json TEXT;

  CREATE TABLE playbooks (
    id TEXT PRIMARY KEY, market TEXT NOT NULL, version INTEGER NOT NULL,
    week_start TEXT NOT NULL, created_at TEXT NOT NULL, model TEXT NOT NULL,
    evidence_json TEXT NOT NULL, document_json TEXT NOT NULL,
    UNIQUE(market, version)
  ) STRICT;
  `,
] as const;

export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
  );
  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const version = index + 1;
    if (applied.has(version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[index] ?? "");
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

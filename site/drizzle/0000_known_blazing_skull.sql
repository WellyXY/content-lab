CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text,
	`rule` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`fired_at` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`delivered_at` text,
	`delivery_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alerts_dedupe_key` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_alerts_fired_at` ON `alerts` (`fired_at`);--> statement-breakpoint
CREATE TABLE `ingest_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`run_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`locked_until` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_ready` ON `jobs` (`status`,`run_at`,`locked_until`);--> statement-breakpoint
CREATE INDEX `idx_jobs_created_at` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`views_delta` integer,
	`coverage` text DEFAULT 'observed' NOT NULL,
	`source` text,
	`ok` integer DEFAULT true NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshots_post_captured` ON `metric_snapshots` (`post_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_captured_at` ON `metric_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `post_features` (
	`post_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`model` text,
	`taxonomy_version` text DEFAULT 'v3' NOT NULL,
	`tags_json` text DEFAULT '{}' NOT NULL,
	`hook_text` text,
	`hook_translation_zh` text,
	`transcript` text,
	`summary_zh` text,
	`formula_zh` text,
	`keyframes_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text,
	`url` text NOT NULL,
	`creator_handle` text,
	`market` text DEFAULT 'VN' NOT NULL,
	`project_tag` text,
	`post_type` text DEFAULT 'video' NOT NULL,
	`caption` text,
	`music_title` text,
	`thumbnail_url` text,
	`published_at` text,
	`bound_at` text NOT NULL,
	`tracking_state` text DEFAULT 'active' NOT NULL,
	`analysis_state` text DEFAULT 'queued' NOT NULL,
	`next_capture_at` text,
	`views` integer DEFAULT 0 NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`shares` integer DEFAULT 0 NOT NULL,
	`saves` integer DEFAULT 0 NOT NULL,
	`delta_24h` integer DEFAULT 0 NOT NULL,
	`source` text,
	`last_captured_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_posts_url` ON `posts` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_posts_video_id` ON `posts` (`video_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_market_state` ON `posts` (`market`,`tracking_state`);--> statement-breakpoint
CREATE INDEX `idx_posts_bound_at` ON `posts` (`bound_at`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`stage` text NOT NULL,
	`made_at` text NOT NULL,
	`rank_position` integer,
	`rank_total` integer,
	`band` text,
	`rationale` text,
	`inputs_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_predictions_post_made_at` ON `predictions` (`post_id`,`made_at`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`event_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`occurred_at` text NOT NULL,
	`accepted_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text,
	`status` text DEFAULT 'online' NOT NULL,
	`queue_depth` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL
);

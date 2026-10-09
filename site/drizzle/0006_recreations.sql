CREATE TABLE `recreations` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`notes_json` text,
	`video_url` text,
	`cover_url` text,
	`error` text,
	`counts` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recreations_post` ON `recreations` (`post_id`,`created_at`);
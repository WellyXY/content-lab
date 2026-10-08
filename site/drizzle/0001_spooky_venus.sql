CREATE TABLE `post_aliases` (
	`source_key` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_post_aliases_post_id` ON `post_aliases` (`post_id`);
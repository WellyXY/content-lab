CREATE TABLE `playbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`version` integer NOT NULL,
	`week_start` text NOT NULL,
	`created_at` text NOT NULL,
	`model` text,
	`document_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`markdown` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_playbooks_market_version` ON `playbooks` (`market`,`version`);--> statement-breakpoint
ALTER TABLE `post_features` ADD `script_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `post_features` ADD `computed_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `post_features` ADD `frames_json` text DEFAULT '[]' NOT NULL;
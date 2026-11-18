CREATE TABLE `creative_guides` (
	`id` text PRIMARY KEY NOT NULL,
	`country` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`model` text,
	`document_json` text NOT NULL,
	`evidence_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_creative_guides_country_version` ON `creative_guides` (`country`,`version`);--> statement-breakpoint
CREATE TABLE `creatives` (
	`video_id` text PRIMARY KEY NOT NULL,
	`model_json` text NOT NULL,
	`spend_30` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);

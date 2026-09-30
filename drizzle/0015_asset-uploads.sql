CREATE TABLE `asset_uploads` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`data` blob,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `asset_uploads_token_id_idx` ON `asset_uploads` (`token_id`);--> statement-breakpoint
CREATE INDEX `asset_uploads_expires_at_idx` ON `asset_uploads` (`expires_at`);
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assets_document_id_idx` ON `assets` (`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_document_id_name_idx` ON `assets` (`document_id`,`name`);
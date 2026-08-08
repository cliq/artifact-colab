CREATE TABLE `watches` (
	`document_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`last_notified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `user_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `watches` (`document_id`, `user_id`, `state`, `last_notified_at`, `created_at`, `updated_at`)
SELECT DISTINCT pair.document_id, pair.user_id, 'watching',
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (
	SELECT `id` AS document_id, `created_by` AS user_id FROM `documents`
	UNION
	SELECT `document_id`, `author_id` AS user_id FROM `comments`
) AS pair;

CREATE TABLE `comment_images` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`position` integer NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comment_images_comment_id_idx` ON `comment_images` (`comment_id`);
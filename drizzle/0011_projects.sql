CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_team_id_name_key_idx` ON `projects` (`team_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `documents` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
CREATE INDEX `documents_team_id_project_id_idx` ON `documents` (`team_id`,`project_id`);
CREATE TABLE `document_collaborators` (
	`document_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edit_requested_at` integer,
	PRIMARY KEY(`document_id`, `user_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_collaborators_role_check" CHECK("document_collaborators"."role" in ('viewer', 'editor'))
);
--> statement-breakpoint
CREATE INDEX `document_collaborators_user_document_idx` ON `document_collaborators` (`user_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `document_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_by` text,
	`accepted_at` integer,
	`delivery_status` text,
	`last_delivery_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_invitations_role_check" CHECK("document_invitations"."role" in ('viewer', 'editor')),
	CONSTRAINT "document_invitations_status_check" CHECK("document_invitations"."status" in ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_invitations_document_email_idx` ON `document_invitations` (`document_id`,`email`);--> statement-breakpoint
CREATE INDEX `document_invitations_email_status_idx` ON `document_invitations` (`email`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_invitations_token_hash_idx` ON `document_invitations` (`token_hash`);
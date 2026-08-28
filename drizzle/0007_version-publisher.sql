ALTER TABLE `versions` ADD `published_by` text REFERENCES users(id);--> statement-breakpoint
UPDATE `versions` SET `published_by` = (SELECT `created_by` FROM `documents` WHERE `documents`.`id` = `versions`.`document_id`) WHERE `published_by` IS NULL;

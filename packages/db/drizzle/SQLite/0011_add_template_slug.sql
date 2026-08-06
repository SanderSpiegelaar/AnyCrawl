ALTER TABLE `templates` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `templates_slug_unique` ON `templates` (`slug`);
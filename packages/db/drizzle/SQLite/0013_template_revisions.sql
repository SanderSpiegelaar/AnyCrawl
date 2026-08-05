CREATE TABLE `template_revisions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`template_uuid` text NOT NULL,
	`version` text NOT NULL,
	`config_hash` text NOT NULL,
	`config_snapshot` text NOT NULL,
	`schema_snapshot` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`template_uuid`) REFERENCES `templates`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_template_revision` ON `template_revisions` (`template_uuid`,`config_hash`);--> statement-breakpoint
CREATE INDEX `ix_template_revision_created` ON `template_revisions` (`template_uuid`,`created_at`,`uuid`);--> statement-breakpoint
ALTER TABLE `templates` ADD `current_revision_uuid` text;
CREATE TABLE `dataset_exports` (
	`uuid` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`format` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`item_count` integer,
	`file_key` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_dataset_export_cursor` ON `dataset_exports` (`dataset_id`,`created_at`,`uuid`);
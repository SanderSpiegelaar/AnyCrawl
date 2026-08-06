CREATE TABLE `template_run_requests` (
	`uuid` text PRIMARY KEY NOT NULL,
	`template_run_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_type` text NOT NULL,
	`seed_key` text,
	`seed_index` integer,
	`parent_request_id` text,
	`normalized_url` text NOT NULL,
	`page_index` integer,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`queue_job_id` text,
	`last_error` text,
	`queued_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`template_run_id`) REFERENCES `template_runs`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_template_run_request` ON `template_run_requests` (`template_run_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `ix_template_run_request_status` ON `template_run_requests` (`template_run_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_template_run_request_seq` ON `template_run_requests` (`template_run_id`,`seed_index`,`page_index`);
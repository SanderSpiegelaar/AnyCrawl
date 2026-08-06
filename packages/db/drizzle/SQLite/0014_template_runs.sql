CREATE TABLE `template_run_events` (
	`uuid` text PRIMARY KEY NOT NULL,
	`template_run_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`template_run_id`) REFERENCES `template_runs`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_template_run_event_cursor` ON `template_run_events` (`template_run_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE TABLE `template_runs` (
	`uuid` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`user_id` text,
	`template_uuid` text NOT NULL,
	`template_revision_uuid` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_scope_hash` text,
	`input_snapshot` text,
	`normalized_input_hash` text,
	`run_options` text,
	`dataset_id` text,
	`dataset_run_uuid` text,
	`legacy_job_uuid` text,
	`statistics` text,
	`stop_reason` text,
	`error_code` text,
	`error_message` text,
	`cancel_requested_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_key`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_uuid`) REFERENCES `templates`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_revision_uuid`) REFERENCES `template_revisions`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_run_uuid`) REFERENCES `dataset_runs`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`legacy_job_uuid`) REFERENCES `jobs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_template_run_user_created` ON `template_runs` (`user_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ix_template_run_apikey_created` ON `template_runs` (`api_key_id`,`created_at`,`uuid`);--> statement-breakpoint
CREATE INDEX `ix_template_run_template_created` ON `template_runs` (`template_uuid`,`created_at`,`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_template_run_idempotency` ON `template_runs` (`template_uuid`,`idempotency_scope_hash`) WHERE "template_runs"."idempotency_scope_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_template_run_revision` ON `template_runs` (`template_revision_uuid`);--> statement-breakpoint
CREATE INDEX `ix_template_run_dataset` ON `template_runs` (`dataset_id`);--> statement-breakpoint
CREATE INDEX `ix_template_run_dataset_run` ON `template_runs` (`dataset_run_uuid`);--> statement-breakpoint
CREATE INDEX `ix_template_run_legacy_job` ON `template_runs` (`legacy_job_uuid`);
CREATE TABLE "template_run_events" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"template_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_runs" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"user_id" uuid,
	"template_uuid" uuid NOT NULL,
	"template_revision_uuid" uuid,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_scope_hash" text,
	"input_snapshot" jsonb,
	"normalized_input_hash" text,
	"run_options" jsonb,
	"dataset_id" uuid,
	"dataset_run_uuid" uuid,
	"legacy_job_uuid" uuid,
	"statistics" jsonb,
	"stop_reason" text,
	"error_code" text,
	"error_message" text,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_run_events" ADD CONSTRAINT "template_run_events_template_run_id_template_runs_uuid_fk" FOREIGN KEY ("template_run_id") REFERENCES "public"."template_runs"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_template_uuid_templates_uuid_fk" FOREIGN KEY ("template_uuid") REFERENCES "public"."templates"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_template_revision_uuid_template_revisions_uuid_fk" FOREIGN KEY ("template_revision_uuid") REFERENCES "public"."template_revisions"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_dataset_run_uuid_dataset_runs_uuid_fk" FOREIGN KEY ("dataset_run_uuid") REFERENCES "public"."dataset_runs"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_legacy_job_uuid_jobs_uuid_fk" FOREIGN KEY ("legacy_job_uuid") REFERENCES "public"."jobs"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_template_run_event_cursor" ON "template_run_events" USING btree ("template_run_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_template_run_user_created" ON "template_runs" USING btree ("user_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_template_run_apikey_created" ON "template_runs" USING btree ("api_key_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_template_run_template_created" ON "template_runs" USING btree ("template_uuid","created_at","uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_template_run_idempotency" ON "template_runs" USING btree ("template_uuid","idempotency_scope_hash") WHERE "template_runs"."idempotency_scope_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_template_run_revision" ON "template_runs" USING btree ("template_revision_uuid");--> statement-breakpoint
CREATE INDEX "ix_template_run_dataset" ON "template_runs" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "ix_template_run_dataset_run" ON "template_runs" USING btree ("dataset_run_uuid");--> statement-breakpoint
CREATE INDEX "ix_template_run_legacy_job" ON "template_runs" USING btree ("legacy_job_uuid");
CREATE TABLE "dataset_item_changes" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"dataset_run_id" uuid NOT NULL,
	"dataset_item_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"change_type" text NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"field_changes" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_item_field_values" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text NOT NULL,
	"string_value" text,
	"number_value" numeric,
	"boolean_value" boolean,
	"timestamptz_value" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dataset_item_field_values_typed_value_chk" CHECK (
        ("dataset_item_field_values"."field_type" = 'string'      AND "dataset_item_field_values"."string_value"      IS NOT NULL AND "dataset_item_field_values"."number_value" IS NULL AND "dataset_item_field_values"."boolean_value" IS NULL AND "dataset_item_field_values"."timestamptz_value" IS NULL)
     OR ("dataset_item_field_values"."field_type" = 'number'      AND "dataset_item_field_values"."number_value"      IS NOT NULL AND "dataset_item_field_values"."string_value" IS NULL AND "dataset_item_field_values"."boolean_value" IS NULL AND "dataset_item_field_values"."timestamptz_value" IS NULL)
     OR ("dataset_item_field_values"."field_type" = 'boolean'     AND "dataset_item_field_values"."boolean_value"     IS NOT NULL AND "dataset_item_field_values"."string_value" IS NULL AND "dataset_item_field_values"."number_value" IS NULL AND "dataset_item_field_values"."timestamptz_value" IS NULL)
     OR ("dataset_item_field_values"."field_type" = 'timestamptz' AND "dataset_item_field_values"."timestamptz_value" IS NOT NULL AND "dataset_item_field_values"."string_value" IS NULL AND "dataset_item_field_values"."number_value" IS NULL AND "dataset_item_field_values"."boolean_value" IS NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "dataset_item_scopes" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"dataset_item_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_items" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"document" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_run_items" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_run_id" uuid NOT NULL,
	"dataset_item_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"sequence" integer,
	"seed_key" text,
	"seed_index" integer,
	"page_index" integer,
	"position" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_runs" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"producer_type" text NOT NULL,
	"producer_id" text NOT NULL,
	"job_uuid" uuid,
	"scheduled_task_uuid" uuid,
	"template_run_uuid" uuid,
	"scope_key" text NOT NULL,
	"status" text NOT NULL,
	"coverage_complete" boolean DEFAULT false NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_created" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_unchanged" integer DEFAULT 0 NOT NULL,
	"items_removed" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"warning_summary" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"source_type" text NOT NULL,
	"source_template_id" text,
	"source_template_revision_uuid" uuid,
	"schema_name" text NOT NULL,
	"schema_version" text NOT NULL,
	"retention_policy" jsonb,
	"item_count" integer DEFAULT 0 NOT NULL,
	"active_item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_warnings" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"template_run_uuid" uuid,
	"dataset_run_id" uuid,
	"scope" text NOT NULL,
	"code" text NOT NULL,
	"message" text,
	"item_key" text,
	"url" text,
	"seed_key" text,
	"seed_index" integer,
	"page_index" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_warnings_run_ref_chk" CHECK ("run_warnings"."template_run_uuid" IS NOT NULL OR "run_warnings"."dataset_run_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "dataset_item_changes" ADD CONSTRAINT "dataset_item_changes_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_item_changes" ADD CONSTRAINT "dataset_item_changes_dataset_run_id_dataset_runs_uuid_fk" FOREIGN KEY ("dataset_run_id") REFERENCES "public"."dataset_runs"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_item_changes" ADD CONSTRAINT "dataset_item_changes_dataset_item_id_dataset_items_uuid_fk" FOREIGN KEY ("dataset_item_id") REFERENCES "public"."dataset_items"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_item_field_values" ADD CONSTRAINT "dataset_item_field_values_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_item_scopes" ADD CONSTRAINT "dataset_item_scopes_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_item_scopes" ADD CONSTRAINT "dataset_item_scopes_dataset_item_id_dataset_items_uuid_fk" FOREIGN KEY ("dataset_item_id") REFERENCES "public"."dataset_items"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_items" ADD CONSTRAINT "dataset_items_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_run_items" ADD CONSTRAINT "dataset_run_items_dataset_run_id_dataset_runs_uuid_fk" FOREIGN KEY ("dataset_run_id") REFERENCES "public"."dataset_runs"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_run_items" ADD CONSTRAINT "dataset_run_items_dataset_item_id_dataset_items_uuid_fk" FOREIGN KEY ("dataset_item_id") REFERENCES "public"."dataset_items"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_runs" ADD CONSTRAINT "dataset_runs_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_runs" ADD CONSTRAINT "dataset_runs_job_uuid_jobs_uuid_fk" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_runs" ADD CONSTRAINT "dataset_runs_scheduled_task_uuid_scheduled_tasks_uuid_fk" FOREIGN KEY ("scheduled_task_uuid") REFERENCES "public"."scheduled_tasks"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_warnings" ADD CONSTRAINT "run_warnings_dataset_run_id_dataset_runs_uuid_fk" FOREIGN KEY ("dataset_run_id") REFERENCES "public"."dataset_runs"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_change" ON "dataset_item_changes" USING btree ("dataset_run_id","item_key","change_type");--> statement-breakpoint
CREATE INDEX "ix_dataset_change_run_cursor" ON "dataset_item_changes" USING btree ("dataset_run_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_dataset_change_dataset_cursor" ON "dataset_item_changes" USING btree ("dataset_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_dataset_change_item" ON "dataset_item_changes" USING btree ("dataset_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_item_field" ON "dataset_item_field_values" USING btree ("dataset_id","item_key","field_name");--> statement-breakpoint
CREATE INDEX "ix_dsfv_string" ON "dataset_item_field_values" USING btree ("dataset_id","field_name","string_value");--> statement-breakpoint
CREATE INDEX "ix_dsfv_number" ON "dataset_item_field_values" USING btree ("dataset_id","field_name","number_value");--> statement-breakpoint
CREATE INDEX "ix_dsfv_boolean" ON "dataset_item_field_values" USING btree ("dataset_id","field_name","boolean_value");--> statement-breakpoint
CREATE INDEX "ix_dsfv_timestamptz" ON "dataset_item_field_values" USING btree ("dataset_id","field_name","timestamptz_value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_item_scope" ON "dataset_item_scopes" USING btree ("dataset_id","item_key","scope_key");--> statement-breakpoint
CREATE INDEX "ix_dataset_item_scope_recon" ON "dataset_item_scopes" USING btree ("dataset_id","scope_key","is_active");--> statement-breakpoint
CREATE INDEX "ix_dataset_item_scope_item" ON "dataset_item_scopes" USING btree ("dataset_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_item" ON "dataset_items" USING btree ("dataset_id","item_key");--> statement-breakpoint
CREATE INDEX "ix_dataset_item_cursor" ON "dataset_items" USING btree ("dataset_id","last_seen_at","uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_run_item" ON "dataset_run_items" USING btree ("dataset_run_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_run_item_sequence" ON "dataset_run_items" USING btree ("dataset_run_id","sequence") WHERE "dataset_run_items"."sequence" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_dataset_run_item_seq" ON "dataset_run_items" USING btree ("dataset_run_id","sequence");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_item_occurrence" ON "dataset_run_items" USING btree ("dataset_run_id","seed_index","page_index","position");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_item_item" ON "dataset_run_items" USING btree ("dataset_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dataset_run_producer" ON "dataset_runs" USING btree ("dataset_id","producer_type","producer_id");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_job" ON "dataset_runs" USING btree ("job_uuid");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_scheduled_task" ON "dataset_runs" USING btree ("scheduled_task_uuid");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_template_run" ON "dataset_runs" USING btree ("template_run_uuid");--> statement-breakpoint
CREATE INDEX "ix_dataset_run_scope" ON "dataset_runs" USING btree ("dataset_id","scope_key","status");--> statement-breakpoint
CREATE INDEX "ix_datasets_user_created" ON "datasets" USING btree ("user_id","created_at","uuid") WHERE "datasets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_datasets_apikey_created" ON "datasets" USING btree ("api_key_id","created_at","uuid") WHERE "datasets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_run_warnings_dataset_run" ON "run_warnings" USING btree ("dataset_run_id","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_run_warnings_template_run" ON "run_warnings" USING btree ("template_run_uuid","created_at","uuid");--> statement-breakpoint
CREATE INDEX "ix_run_warnings_code" ON "run_warnings" USING btree ("dataset_run_id","code");
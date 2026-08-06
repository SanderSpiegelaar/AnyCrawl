CREATE TABLE "template_run_requests" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"template_run_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"request_type" text NOT NULL,
	"seed_key" text,
	"seed_index" integer,
	"parent_request_id" uuid,
	"normalized_url" text NOT NULL,
	"page_index" integer,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"queue_job_id" text,
	"last_error" text,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_run_requests" ADD CONSTRAINT "template_run_requests_template_run_id_template_runs_uuid_fk" FOREIGN KEY ("template_run_id") REFERENCES "public"."template_runs"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_template_run_request" ON "template_run_requests" USING btree ("template_run_id","request_key");--> statement-breakpoint
CREATE INDEX "ix_template_run_request_status" ON "template_run_requests" USING btree ("template_run_id","status");--> statement-breakpoint
CREATE INDEX "ix_template_run_request_seq" ON "template_run_requests" USING btree ("template_run_id","seed_index","page_index");
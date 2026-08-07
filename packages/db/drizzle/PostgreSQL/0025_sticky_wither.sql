CREATE TABLE "dataset_exports" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"item_count" integer,
	"file_key" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dataset_exports" ADD CONSTRAINT "dataset_exports_dataset_id_datasets_uuid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_dataset_export_cursor" ON "dataset_exports" USING btree ("dataset_id","created_at","uuid");
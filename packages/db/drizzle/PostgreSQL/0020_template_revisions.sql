CREATE TABLE "template_revisions" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"template_uuid" uuid NOT NULL,
	"version" text NOT NULL,
	"config_hash" text NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"schema_snapshot" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "current_revision_uuid" uuid;--> statement-breakpoint
ALTER TABLE "template_revisions" ADD CONSTRAINT "template_revisions_template_uuid_templates_uuid_fk" FOREIGN KEY ("template_uuid") REFERENCES "public"."templates"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_template_revision" ON "template_revisions" USING btree ("template_uuid","config_hash");--> statement-breakpoint
CREATE INDEX "ix_template_revision_created" ON "template_revisions" USING btree ("template_uuid","created_at","uuid");
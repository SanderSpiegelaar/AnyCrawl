ALTER TABLE "dataset_item_field_values" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "dataset_item_field_values" CASCADE;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "query_fields" jsonb;--> statement-breakpoint
CREATE INDEX "ix_dataset_item_document_gin" ON "dataset_items" USING gin ("document" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "ix_datasets_user_name" ON "datasets" USING btree ("user_id","name") WHERE "datasets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_datasets_apikey_name" ON "datasets" USING btree ("api_key_id","name") WHERE "datasets"."deleted_at" IS NULL;
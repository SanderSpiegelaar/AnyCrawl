DROP TABLE `dataset_item_field_values`;--> statement-breakpoint
ALTER TABLE `datasets` ADD `query_fields` text;--> statement-breakpoint
CREATE INDEX `ix_datasets_user_name` ON `datasets` (`user_id`,`name`) WHERE "datasets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `ix_datasets_apikey_name` ON `datasets` (`api_key_id`,`name`) WHERE "datasets"."deleted_at" IS NULL;
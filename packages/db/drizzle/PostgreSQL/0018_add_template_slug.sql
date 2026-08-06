ALTER TABLE "templates" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_slug_unique" UNIQUE("slug");
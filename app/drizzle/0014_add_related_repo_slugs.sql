ALTER TABLE "projects" ADD COLUMN "related_repo_slugs" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "related_repo_slugs" text[] DEFAULT '{}' NOT NULL;
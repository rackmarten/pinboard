ALTER TABLE "projects" ADD COLUMN "review_mode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "stacked_on_task_id" integer;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "stacked_on_sha" text;
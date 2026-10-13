ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "root_scope" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "root_grant_ctids" integer[];--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "root_grant_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "root_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "root_granted_by" text;
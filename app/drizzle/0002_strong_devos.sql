ALTER TABLE "tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
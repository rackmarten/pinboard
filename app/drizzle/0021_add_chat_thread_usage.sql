ALTER TABLE "chat_threads" ADD COLUMN "total_cost_usd" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "total_duration_ms" integer DEFAULT 0 NOT NULL;
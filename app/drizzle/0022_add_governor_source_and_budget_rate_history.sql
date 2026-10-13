CREATE TABLE IF NOT EXISTS "budget_rate_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"usd_per_session_percent" text NOT NULL,
	"usd_per_week_percent" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_observations" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
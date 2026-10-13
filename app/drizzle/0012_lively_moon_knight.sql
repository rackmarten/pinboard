CREATE TABLE IF NOT EXISTS "budget_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"usd_per_session_percent" text NOT NULL,
	"usd_per_week_percent" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

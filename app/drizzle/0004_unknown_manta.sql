CREATE TABLE IF NOT EXISTS "usage_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"percent_remaining" integer NOT NULL,
	"note" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

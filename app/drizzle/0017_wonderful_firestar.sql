CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"weekly_reset_day_of_week" integer,
	"weekly_reset_hour" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

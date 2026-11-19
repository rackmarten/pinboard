CREATE TABLE IF NOT EXISTS "activity_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_key" text NOT NULL,
	"kind" text NOT NULL,
	"route" text NOT NULL,
	"name" text NOT NULL,
	"value" integer NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_minutes" (
	"actor_key" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"route" text NOT NULL,
	"name" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "activity_minutes_actor_key_minute_kind_route_name_pk" PRIMARY KEY("actor_key","minute","kind","route","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_settings" (
	"actor_key" text PRIMARY KEY NOT NULL,
	"usage_tracking" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_events_received_at_idx" ON "activity_events" USING btree ("received_at");
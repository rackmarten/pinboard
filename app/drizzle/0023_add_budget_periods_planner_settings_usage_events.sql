CREATE TABLE IF NOT EXISTS "budget_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"budget_usd" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cost_usd" text NOT NULL,
	"source" text NOT NULL,
	"task_id" integer,
	"chat_thread_id" integer,
	"handoff_id" integer
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "session_budget_usd" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_task_cost_usd" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "concurrency_global" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- backfill every existing handoff as a usage event, so session
-- windows and period spend can be derived over the full history rather than
-- only from the moment this migration ran. Guarded by NOT EXISTS so a re-run
-- (or a partially applied migration) can't double-count. Historical chat
-- spend is deliberately NOT backfilled: chat_threads only ever stored a
-- running total, so there are no per-turn timestamps to attribute.
INSERT INTO "usage_events" ("occurred_at", "cost_usd", "source", "task_id", "handoff_id")
SELECT h."created_at", h."cost_usd", 'handoff', h."task_id", h."id"
FROM "handoffs" h
WHERE h."cost_usd" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "usage_events" ue WHERE ue."handoff_id" = h."id");
--> statement-breakpoint
-- Every planner query is "events in a time range, oldest first".
CREATE INDEX IF NOT EXISTS "usage_events_occurred_at_idx" ON "usage_events" ("occurred_at");

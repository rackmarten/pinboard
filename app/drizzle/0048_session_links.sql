CREATE TABLE IF NOT EXISTS "session_links" (
	"session_id" text NOT NULL,
	"task_id" integer NOT NULL,
	"cwd" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_links_session_id_task_id_pk" PRIMARY KEY("session_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "session_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_links" ADD CONSTRAINT "session_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_links_task_id_idx" ON "session_links" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_session_id_idx" ON "usage_events" USING btree ("session_id");
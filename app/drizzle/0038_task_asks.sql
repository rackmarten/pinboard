CREATE TABLE IF NOT EXISTS "task_asks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"thread_id" integer,
	"kind" text NOT NULL,
	"context" text,
	"question" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_option" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"answer_option" integer,
	"answer_text" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "summary" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_asks" ADD CONSTRAINT "task_asks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_asks" ADD CONSTRAINT "task_asks_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_asks_status_idx" ON "task_asks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_asks_task_id_idx" ON "task_asks" USING btree ("task_id");
CREATE TABLE IF NOT EXISTS "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"url" text NOT NULL,
	"repo_slug" text NOT NULL,
	"branch_name" text,
	"state" text DEFAULT 'open' NOT NULL,
	"attempt_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

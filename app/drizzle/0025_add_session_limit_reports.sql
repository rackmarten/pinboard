CREATE TABLE IF NOT EXISTS "session_limit_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	"license_id" integer NOT NULL,
	"task_id" integer,
	"raw_error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_limit_reports" ADD CONSTRAINT "session_limit_reports_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_limit_reports" ADD CONSTRAINT "session_limit_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

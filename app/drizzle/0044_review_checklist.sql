CREATE TABLE IF NOT EXISTS "checklist_ticks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"item" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"note" text,
	"checked_at" timestamp with time zone,
	"checked_by" text
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "checklist" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checklist_ticks" ADD CONSTRAINT "checklist_ticks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_ticks_task_item_idx" ON "checklist_ticks" USING btree ("task_id","item");
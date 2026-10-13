ALTER TABLE "tasks" ADD COLUMN "pipeline_stage_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repair_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repair_context" text;
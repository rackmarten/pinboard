-- server-kit keyword search. Rows are backfilled at startup by
-- src/keywords.ts (normalization is JS, so it cannot run here).
ALTER TABLE "projects" ADD COLUMN "keywords" "tsvector";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "keywords" "tsvector";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_keywords_idx" ON "projects" USING gin ("keywords");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_keywords_idx" ON "tasks" USING gin ("keywords");
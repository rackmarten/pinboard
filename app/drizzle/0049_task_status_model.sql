ALTER TABLE "tasks" ADD COLUMN "review_reason" text;--> statement-breakpoint
-- The status model change: planned, handoff and awaiting_review are gone and
-- executing is in_progress. task-model.ts's STATUS_MIGRATION is the same
-- mapping (its test reads this file). todo/backlog were never real statuses
-- but are folded in too, in case a script stored one. decomposed stays.
UPDATE "tasks" SET "status" = 'defined' WHERE "status" IN ('planned', 'todo', 'backlog');--> statement-breakpoint
UPDATE "tasks" SET "status" = 'in_progress' WHERE "status" = 'executing';--> statement-breakpoint
-- awaiting_review was only ever the hold before a migration diff merged.
UPDATE "tasks" SET "status" = 'review', "review_reason" = 'migration', "pipeline_stage_entered_at" = NULL WHERE "status" = 'awaiting_review';--> statement-breakpoint
-- a handoff is an event now, not a status. A task still sitting in it was
-- left there by a session whose outcome never got recorded, so it goes to
-- rework with a comment saying why.
WITH moved AS (
  UPDATE "tasks" SET "status" = 'rework', "updated_at" = now() WHERE "status" = 'handoff' RETURNING "id", "project_id"
), noted AS (
  INSERT INTO "comments" ("task_id", "author_type", "author_name", "body")
  SELECT "id", 'system', 'pinboard', 'Moved from handoff to rework: handoff is no longer a status. The latest handoff above says how the session ended; requeue or close the task from here.'
  FROM moved
  RETURNING "id", "task_id"
)
INSERT INTO "task_events" ("task_id", "project_id", "event_type", "actor_type", "actor_name", "payload")
SELECT moved."id", moved."project_id", 'status', 'system', 'pinboard', jsonb_build_object('from', 'handoff', 'to', 'rework', 'reason', 'handoff is no longer a status')
FROM moved;

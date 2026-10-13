ALTER TABLE "tasks" ADD COLUMN "claude_session_license_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claude_session_license_id_licenses_id_fk" FOREIGN KEY ("claude_session_license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- every session retained before this column existed was created
-- under the original single seat, so backfill those rows to it rather than
-- throwing three live resumable sessions away on deploy. Same "backfill to
-- the default license, zero operator action post-deploy" shape as 0024.
-- If that row was renamed this matches nothing and the rows stay null, which
-- foreman reads as "owner unknown" and handles by starting cold - the safe
-- direction to fail in.
UPDATE "tasks"
SET "claude_session_license_id" = (SELECT "id" FROM "licenses" WHERE "name" = 'default')
WHERE "claude_session_id" IS NOT NULL AND "claude_session_license_id" IS NULL;

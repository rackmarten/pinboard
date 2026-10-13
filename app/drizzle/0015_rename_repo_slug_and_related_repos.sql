ALTER TABLE "projects" RENAME COLUMN "repo_slug" TO "local_path";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "related_repo_slugs" TO "related_project_ids";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "related_repo_slugs" TO "related_project_ids";--> statement-breakpoint

-- related_project_ids previously stored repo path/slug strings
-- (matched against projects.local_path, which at this point in the
-- migration still holds its pre-#70 value - resolved here, before that
-- column gets rewritten below). Postgres won't allow a subquery directly
-- in ALTER COLUMN ... TYPE ... USING, so this goes via a temp column
-- instead. Any string with no matching project is dropped rather than
-- failing the migration - better to lose a stale reference than block the
-- whole deploy.
ALTER TABLE "projects" ADD COLUMN "related_project_ids_tmp" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "projects" SET "related_project_ids_tmp" = COALESCE(
  (SELECT array_agg(p2.id) FROM unnest(related_project_ids) AS u(old_value) JOIN projects p2 ON p2.local_path = u.old_value),
  '{}'::integer[]
);--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "related_project_ids";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "related_project_ids_tmp" TO "related_project_ids";--> statement-breakpoint

ALTER TABLE "tasks" ADD COLUMN "related_project_ids_tmp" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "related_project_ids_tmp" = COALESCE(
  (SELECT array_agg(p2.id) FROM unnest(related_project_ids) AS u(old_value) JOIN projects p2 ON p2.local_path = u.old_value),
  '{}'::integer[]
);--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "related_project_ids";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "related_project_ids_tmp" TO "related_project_ids";--> statement-breakpoint

-- workspace root moves up one level (~/projects instead of
-- ~/projects/uncik-homelab), so every local_path becomes org/name. Fixes
-- the rows that had already drifted to a raw absolute path (broken under
-- the old path.join-based resolution - see homelab/AGENTS.md's write-up)
-- at the same time as the rows that were still a bare name.
UPDATE "projects" SET "local_path" = regexp_replace("local_path", '^/home/marek/projects/', '')
  WHERE "local_path" LIKE '/home/marek/projects/%';--> statement-breakpoint
UPDATE "projects" SET "local_path" = 'uncik-homelab/' || "local_path"
  WHERE "local_path" IS NOT NULL
    AND "local_path" NOT LIKE '%/%'
    AND "local_path" NOT IN ('uncik-homelab', 'uncik-projects');

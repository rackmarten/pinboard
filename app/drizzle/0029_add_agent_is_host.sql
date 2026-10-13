ALTER TABLE "agents" ADD COLUMN "is_host" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- keep the existing agent literally named "foreman-host" working
-- as marek's host persona post-migration, since chat.ts stops matching on
-- that name once #179 lands - without this an operator would need to flip
-- the switch by hand right after deploy.
UPDATE "agents" SET "is_host" = true WHERE "name" = 'foreman-host';
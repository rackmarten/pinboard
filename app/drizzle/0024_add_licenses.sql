CREATE TABLE IF NOT EXISTS "licenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"linux_user" text NOT NULL,
	"session_budget_usd" text,
	"concurrency_limit" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_name_unique" UNIQUE("name")
);
--> statement-breakpoint
-- a single default license so every existing agent/budget
-- period/usage event backfills to it below - zero operator action required
-- post-deploy. linux_user "marek" matches the only Linux user foreman has
-- ever dispatched under; provider "anthropic" matches every Claude-backed
-- agent's own provider value today.
INSERT INTO "licenses" ("name", "provider", "linux_user")
SELECT 'default', 'anthropic', 'marek'
WHERE NOT EXISTS (SELECT 1 FROM "licenses" WHERE "name" = 'default');
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "license_id" integer;
--> statement-breakpoint
UPDATE "agents" SET "license_id" = (SELECT "id" FROM "licenses" WHERE "name" = 'default') WHERE "license_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "license_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "budget_periods" ADD COLUMN IF NOT EXISTS "license_id" integer;
--> statement-breakpoint
UPDATE "budget_periods" SET "license_id" = (SELECT "id" FROM "licenses" WHERE "name" = 'default') WHERE "license_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "budget_periods" ALTER COLUMN "license_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "license_id" integer;
--> statement-breakpoint
UPDATE "usage_events" SET "license_id" = (SELECT "id" FROM "licenses" WHERE "name" = 'default') WHERE "license_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "license_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

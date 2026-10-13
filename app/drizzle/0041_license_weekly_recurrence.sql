ALTER TABLE "licenses" ADD COLUMN "recurrence_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "recurrence_budget_usd" text;
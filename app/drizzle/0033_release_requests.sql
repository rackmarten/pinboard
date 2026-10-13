ALTER TABLE "deploy_requests" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'deploy' NOT NULL;--> statement-breakpoint
ALTER TABLE "deploy_requests" ADD COLUMN IF NOT EXISTS "bump" text;--> statement-breakpoint
ALTER TABLE "deploy_requests" ADD COLUMN IF NOT EXISTS "version" text;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN IF NOT EXISTS "release" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN IF NOT EXISTS "deployed_version" text;
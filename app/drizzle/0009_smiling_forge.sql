CREATE TABLE IF NOT EXISTS "routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text,
	"label_name" text,
	"agent_id" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "worker_heartbeat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"queue" text NOT NULL,
	"enabled" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeat_one_per_queue" UNIQUE("candidate_id","queue"),
	CONSTRAINT "worker_heartbeat_queue_known" CHECK ("worker_heartbeat"."queue" in ('pipeline', 'apply-browser'))
);
--> statement-breakpoint
ALTER TABLE "worker_heartbeat" ADD CONSTRAINT "worker_heartbeat_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Worker heartbeats are state, not history (NS-225 slice 3): one row per candidate and queue,
-- overwritten every beat, like dependency_breaker, so no append-only trigger. Grants the app role
-- by the NS-212 rule (migration 0065): SELECT, INSERT, UPDATE and DELETE on a table no trigger guards.
SELECT northstar_grant_app_role();

CREATE TABLE "company_watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"board" text NOT NULL,
	"url" text NOT NULL,
	"tier" integer NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"jobs_found" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_watch_board_unique" UNIQUE("candidate_id","ats","board"),
	CONSTRAINT "company_watch_ats_valid" CHECK ("company_watch"."ats" in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable')),
	CONSTRAINT "company_watch_tier_valid" CHECK ("company_watch"."tier" in (1, 2, 3)),
	CONSTRAINT "company_watch_status_valid" CHECK ("company_watch"."status" in ('ok', 'backing_off', 'quarantined')),
	CONSTRAINT "company_watch_failures_nonnegative" CHECK ("company_watch"."consecutive_failures" >= 0),
	CONSTRAINT "company_watch_url_https" CHECK ("company_watch"."url" ~ '^https://')
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ats_valid";--> statement-breakpoint
ALTER TABLE "job_source" DROP CONSTRAINT "job_source_ats_valid";--> statement-breakpoint
ALTER TABLE "company_watch" ADD CONSTRAINT "company_watch_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ats_valid" CHECK ("job"."ats" is null or "job"."ats" in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable'));--> statement-breakpoint
ALTER TABLE "job_source" ADD CONSTRAINT "job_source_ats_valid" CHECK ("job_source"."ats" is null or "job_source"."ats" in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable'));

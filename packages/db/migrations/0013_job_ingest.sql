CREATE TABLE "job_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"url" text NOT NULL,
	"method" text NOT NULL,
	"ats" text,
	"ats_posting_id" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_source_url_unique" UNIQUE("candidate_id","url"),
	CONSTRAINT "job_source_method_valid" CHECK ("job_source"."method" in ('ats_api', 'jsonld', 'model', 'text')),
	CONSTRAINT "job_source_ats_valid" CHECK ("job_source"."ats" is null or "job_source"."ats" in ('greenhouse', 'lever', 'ashby', 'workday')),
	CONSTRAINT "job_source_url_http" CHECK ("job_source"."url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "missing_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "remote" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "salary_min" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "salary_max" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "salary_currency" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "salary_period" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "seniority" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "requirements" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "nice_to_haves" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "apply_url" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "ats" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_source" ADD CONSTRAINT "job_source_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source" ADD CONSTRAINT "job_source_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_source_ats_posting_unique" ON "job_source" USING btree ("candidate_id","ats","ats_posting_id") WHERE "job_source"."ats_posting_id" is not null;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_status_valid" CHECK ("job"."status" in ('draft', 'ready'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ready_complete" CHECK ("job"."status" <> 'ready' or ("job"."company_id" is not null and "job"."title" is not null and length(trim("job"."title")) > 0));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_remote_valid" CHECK ("job"."remote" is null or "job"."remote" in ('onsite', 'hybrid', 'remote'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_salary_order" CHECK ("job"."salary_min" is null or "job"."salary_max" is null or "job"."salary_min" <= "job"."salary_max");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_salary_period_valid" CHECK ("job"."salary_period" is null or "job"."salary_period" in ('year', 'month', 'hour'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ats_valid" CHECK ("job"."ats" is null or "job"."ats" in ('greenhouse', 'lever', 'ashby', 'workday'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_url_http" CHECK ("job"."url" ~ '^https?://');--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_apply_url_http" CHECK ("job"."apply_url" is null or "job"."apply_url" ~ '^https?://');

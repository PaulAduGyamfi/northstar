CREATE TABLE "tailored_resume" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile_source_id" uuid NOT NULL,
	"resume" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"score" jsonb NOT NULL,
	"dropped_skills" text[] NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tailored_resume_version_unique" UNIQUE("candidate_id","job_id","version"),
	CONSTRAINT "tailored_resume_version_positive" CHECK ("tailored_resume"."version" >= 1),
	CONSTRAINT "tailored_resume_sha_format" CHECK ("tailored_resume"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "tailored_resume" ADD CONSTRAINT "tailored_resume_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_resume" ADD CONSTRAINT "tailored_resume_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_resume" ADD CONSTRAINT "tailored_resume_source_same_candidate_fk" FOREIGN KEY ("profile_source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;

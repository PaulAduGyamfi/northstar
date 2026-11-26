CREATE TABLE "job_form" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "job_form_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"sha256" text NOT NULL,
	"questions" jsonb NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_form_position_unique" UNIQUE("position"),
	CONSTRAINT "job_form_sha256_shape" CHECK ("job_form"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_form_questions_array" CHECK (jsonb_typeof("job_form"."questions") = 'array')
);
--> statement-breakpoint
ALTER TABLE "job_form" ADD CONSTRAINT "job_form_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_form" ADD CONSTRAINT "job_form_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;

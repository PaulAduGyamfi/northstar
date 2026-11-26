CREATE TABLE "recruiter_grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"grade" text NOT NULL,
	"points" integer NOT NULL,
	"reasons" text[] NOT NULL,
	"confidence" text NOT NULL,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recruiter_grade_one_per_message" UNIQUE("candidate_id","gmail_message_id"),
	CONSTRAINT "recruiter_grade_gmail_id_shape" CHECK ("recruiter_grade"."gmail_message_id" ~ '^[0-9a-f]{1,32}$'),
	CONSTRAINT "recruiter_grade_grade_valid" CHECK ("recruiter_grade"."grade" in ('A', 'B', 'C', 'D', 'F')),
	CONSTRAINT "recruiter_grade_points_range" CHECK ("recruiter_grade"."points" between -50 and 50),
	CONSTRAINT "recruiter_grade_confidence_valid" CHECK ("recruiter_grade"."confidence" in ('normal', 'low')),
	CONSTRAINT "recruiter_grade_reasons_shape" CHECK (cardinality("recruiter_grade"."reasons") between 1 and 12 and array_position("recruiter_grade"."reasons", null) is null and array_to_string("recruiter_grade"."reasons", ',') ~ '^(dealbreaker|[a-z_]+:[a-z_]+)(,(dealbreaker|[a-z_]+:[a-z_]+))*$')
);
--> statement-breakpoint
ALTER TABLE "recruiter_grade" ADD CONSTRAINT "recruiter_grade_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;

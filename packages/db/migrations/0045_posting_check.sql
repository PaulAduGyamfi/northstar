CREATE TABLE "posting_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "posting_check_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_check_position_unique" UNIQUE("position"),
	CONSTRAINT "posting_check_outcome_valid" CHECK ("posting_check"."outcome" in ('open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "posting_check" ADD CONSTRAINT "posting_check_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_check" ADD CONSTRAINT "posting_check_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;

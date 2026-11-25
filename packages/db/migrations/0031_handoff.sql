CREATE TABLE "apply_handoff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"apply_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "apply_handoff_one_per_submission" UNIQUE("submission_id"),
	CONSTRAINT "apply_handoff_url_https" CHECK ("apply_handoff"."apply_url" ~ '^https://[^\s]+$'),
	CONSTRAINT "apply_handoff_url_length" CHECK (length("apply_handoff"."apply_url") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "apply_handoff_done" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"handoff_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"done_at" timestamp with time zone NOT NULL,
	CONSTRAINT "apply_handoff_done_once" UNIQUE("handoff_id"),
	CONSTRAINT "apply_handoff_done_outcome_valid" CHECK ("apply_handoff_done"."outcome" in ('submitted', 'gave_up'))
);
--> statement-breakpoint
ALTER TABLE "apply_handoff" ADD CONSTRAINT "apply_handoff_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_handoff" ADD CONSTRAINT "apply_handoff_submission_id_apply_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."apply_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_handoff_done" ADD CONSTRAINT "apply_handoff_done_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_handoff_done" ADD CONSTRAINT "apply_handoff_done_handoff_id_apply_handoff_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."apply_handoff"("id") ON DELETE no action ON UPDATE no action;

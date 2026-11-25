CREATE TABLE "apply_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"requisition_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "apply_submission_idempotency_unique" UNIQUE("candidate_id","idempotency_key"),
	CONSTRAINT "apply_submission_requisition_unique" UNIQUE("candidate_id","requisition_key"),
	CONSTRAINT "apply_submission_application_unique" UNIQUE("candidate_id","application_id"),
	CONSTRAINT "apply_submission_ats_valid" CHECK ("apply_submission"."ats" in ('greenhouse', 'lever', 'ashby')),
	CONSTRAINT "apply_submission_status_valid" CHECK ("apply_submission"."status" in ('in_progress', 'submitted', 'needs_human')),
	CONSTRAINT "apply_submission_reason_valid" CHECK (("apply_submission"."status" = 'needs_human' and "apply_submission"."reason" in ('captcha', 'login', 'mfa', 'account', 'unmapped_required', 'form_changed', 'no_confirmation', 'driver_error', 'outcome_unknown', 'status_conflict'))
        or ("apply_submission"."status" <> 'needs_human' and "apply_submission"."reason" is null)),
	CONSTRAINT "apply_submission_finished" CHECK (("apply_submission"."status" = 'in_progress') = ("apply_submission"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "submission_proof" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"confirmation_html" text NOT NULL,
	"html_sha256" text NOT NULL,
	"screenshot_png" "bytea" NOT NULL,
	"screenshot_sha256" text NOT NULL,
	"field_values" jsonb NOT NULL,
	"resume_sha256" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "submission_proof_one_per_submission" UNIQUE("submission_id"),
	CONSTRAINT "submission_proof_html_sha256_format" CHECK ("submission_proof"."html_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_proof_screenshot_sha256_format" CHECK ("submission_proof"."screenshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_proof_resume_sha256_format" CHECK ("submission_proof"."resume_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "apply_submission" ADD CONSTRAINT "apply_submission_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_submission" ADD CONSTRAINT "apply_submission_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_submission" ADD CONSTRAINT "apply_submission_decision_id_approval_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."approval_decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_proof" ADD CONSTRAINT "submission_proof_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_proof" ADD CONSTRAINT "submission_proof_submission_id_apply_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."apply_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apply_submission_one_in_progress_per_ats" ON "apply_submission" USING btree ("candidate_id","ats") WHERE "apply_submission"."status" = 'in_progress';

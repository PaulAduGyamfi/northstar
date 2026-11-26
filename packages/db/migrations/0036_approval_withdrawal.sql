CREATE TABLE "approval_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"withdrawn_by" text NOT NULL,
	"reason" text NOT NULL,
	"withdrawn_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_withdrawal_one_per_request" UNIQUE("request_id"),
	CONSTRAINT "approval_withdrawal_by_valid" CHECK ("approval_withdrawal"."withdrawn_by" in ('user', 'gateway')),
	CONSTRAINT "approval_withdrawal_reason_valid" CHECK ("approval_withdrawal"."reason" in ('paul', 'content_changed')),
	CONSTRAINT "approval_withdrawal_reason_matches_by" CHECK (("approval_withdrawal"."withdrawn_by" = 'user' and "approval_withdrawal"."reason" = 'paul') or ("approval_withdrawal"."withdrawn_by" = 'gateway' and "approval_withdrawal"."reason" = 'content_changed'))
);
--> statement-breakpoint
ALTER TABLE "approval_withdrawal" ADD CONSTRAINT "approval_withdrawal_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_withdrawal" ADD CONSTRAINT "approval_withdrawal_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id") REFERENCES "public"."approval_request"("id","candidate_id") ON DELETE no action ON UPDATE no action;

CREATE TABLE "interview_prep_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "interview_prep_block_once" UNIQUE("proposal_id","starts_at"),
	CONSTRAINT "interview_prep_block_kind_listed" CHECK ("interview_prep_block"."kind" in ('prep', 'warm_up')),
	CONSTRAINT "interview_prep_block_ends_after_start" CHECK ("interview_prep_block"."ends_at" > "interview_prep_block"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "interview_prep_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"detection_id" uuid NOT NULL,
	"missing_prep" integer NOT NULL,
	"warm_up_missing" boolean NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_prep_proposal_once" UNIQUE("detection_id"),
	CONSTRAINT "interview_prep_proposal_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "interview_prep_proposal_missing_range" CHECK ("interview_prep_proposal"."missing_prep" between 0 and 2)
);
--> statement-breakpoint
ALTER TABLE "interview_prep_block" ADD CONSTRAINT "interview_prep_block_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_prep_block" ADD CONSTRAINT "interview_prep_block_proposal_same_candidate_fk" FOREIGN KEY ("proposal_id","candidate_id") REFERENCES "public"."interview_prep_proposal"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_prep_proposal" ADD CONSTRAINT "interview_prep_proposal_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Proposed interview prep is append-only (NS-241, ADR-0012): a proposal is stored once per
-- detection and never edited. Reuses the Approval Gate's reject function (migration 0016), then
-- grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER interview_prep_proposal_no_update_or_delete
  BEFORE UPDATE OR DELETE ON interview_prep_proposal
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_prep_proposal_no_truncate
  BEFORE TRUNCATE ON interview_prep_proposal
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_prep_block_no_update_or_delete
  BEFORE UPDATE OR DELETE ON interview_prep_block
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_prep_block_no_truncate
  BEFORE TRUNCATE ON interview_prep_block
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

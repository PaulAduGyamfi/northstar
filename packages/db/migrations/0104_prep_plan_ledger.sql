CREATE TABLE "northstar_calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "northstar_calendar_one_per_candidate" UNIQUE("candidate_id"),
	CONSTRAINT "northstar_calendar_id_shape" CHECK ("northstar_calendar"."calendar_id" ~ '^[a-z0-9_]{1,128}@group[.]calendar[.]google[.]com$')
);
--> statement-breakpoint
CREATE TABLE "prep_plan_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_kind" text DEFAULT 'prep_plan' NOT NULL,
	"proposal_id" uuid NOT NULL,
	"detection_id" uuid NOT NULL,
	"detection_version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_plan_request_request_unique" UNIQUE("request_id"),
	CONSTRAINT "prep_plan_request_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "prep_plan_request_kind" CHECK ("prep_plan_request"."request_kind" = 'prep_plan'),
	CONSTRAINT "prep_plan_request_version_range" CHECK ("prep_plan_request"."detection_version" between 1 and 10),
	CONSTRAINT "prep_plan_request_sha256_shape" CHECK ("prep_plan_request"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "prep_write_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_write_claim_one_per_attempt" UNIQUE("candidate_id","decision_id","attempt"),
	CONSTRAINT "prep_write_claim_attempt_range" CHECK ("prep_write_claim"."attempt" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "prep_write_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"block_count" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_write_record_one_per_decision" UNIQUE("candidate_id","decision_id"),
	CONSTRAINT "prep_write_record_block_count_range" CHECK ("prep_write_record"."block_count" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "northstar_calendar" ADD CONSTRAINT "northstar_calendar_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_plan_request" ADD CONSTRAINT "prep_plan_request_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_plan_request" ADD CONSTRAINT "prep_plan_request_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id","request_kind","content_sha256") REFERENCES "public"."approval_request"("id","candidate_id","kind","content_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_plan_request" ADD CONSTRAINT "prep_plan_request_proposal_same_candidate_fk" FOREIGN KEY ("proposal_id","candidate_id") REFERENCES "public"."interview_prep_proposal"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_write_claim" ADD CONSTRAINT "prep_write_claim_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_write_record" ADD CONSTRAINT "prep_write_record_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Prep plans and the Calendar writer's ledger are append-only (NS-241 slice 4, ADR-0012,
-- ADR-0031 items 3 and 5): a filed plan, a claim, a recorded write or the calendar's id is never
-- edited or removed, so one approval can only ever write its blocks once. Reuses the Approval
-- Gate's reject function (migration 0016), then grants the app role by the NS-212 rule
-- (migration 0065).
CREATE TRIGGER northstar_calendar_no_update_or_delete
  BEFORE UPDATE OR DELETE ON northstar_calendar
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER northstar_calendar_no_truncate
  BEFORE TRUNCATE ON northstar_calendar
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_plan_request_no_update_or_delete
  BEFORE UPDATE OR DELETE ON prep_plan_request
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_plan_request_no_truncate
  BEFORE TRUNCATE ON prep_plan_request
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_write_claim_no_update_or_delete
  BEFORE UPDATE OR DELETE ON prep_write_claim
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_write_claim_no_truncate
  BEFORE TRUNCATE ON prep_write_claim
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_write_record_no_update_or_delete
  BEFORE UPDATE OR DELETE ON prep_write_record
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER prep_write_record_no_truncate
  BEFORE TRUNCATE ON prep_write_record
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

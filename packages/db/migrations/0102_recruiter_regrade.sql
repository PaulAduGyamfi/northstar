CREATE TABLE "recruiter_regrade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"grade" text NOT NULL,
	"regraded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recruiter_regrade_gmail_id_shape" CHECK ("recruiter_regrade"."gmail_message_id" ~ '^[0-9a-f]{1,32}$'),
	CONSTRAINT "recruiter_regrade_grade_valid" CHECK ("recruiter_regrade"."grade" in ('A', 'B', 'C', 'D', 'F'))
);
--> statement-breakpoint
ALTER TABLE "recruiter_regrade" ADD CONSTRAINT "recruiter_regrade_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recruiter_regrade_message" ON "recruiter_regrade" USING btree ("candidate_id","gmail_message_id","regraded_at");--> statement-breakpoint
-- Paul's regrades are append-only (NS-238 item 3, ADR-0012): a change of letter is a new row.
-- Reuses the Approval Gate's reject function (migration 0016), then grants the app role by the
-- NS-212 rule (migration 0065).
CREATE TRIGGER recruiter_regrade_no_update_or_delete
  BEFORE UPDATE OR DELETE ON recruiter_regrade
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER recruiter_regrade_no_truncate
  BEFORE TRUNCATE ON recruiter_regrade
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

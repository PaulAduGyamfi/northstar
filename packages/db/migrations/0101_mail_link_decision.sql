CREATE TABLE "mail_link_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"decision" text NOT NULL,
	"application_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_link_decision_one_per_message" UNIQUE("candidate_id","gmail_message_id"),
	CONSTRAINT "mail_link_decision_gmail_ids_shape" CHECK ("mail_link_decision"."gmail_message_id" ~ '^[0-9a-f]{1,32}$' and "mail_link_decision"."gmail_thread_id" ~ '^[0-9a-f]{1,32}$'),
	CONSTRAINT "mail_link_decision_shape" CHECK (("mail_link_decision"."decision" = 'linked' and "mail_link_decision"."application_id" is not null)
        or ("mail_link_decision"."decision" = 'dismissed' and "mail_link_decision"."application_id" is null))
);
--> statement-breakpoint
ALTER TABLE "mail_link_decision" ADD CONSTRAINT "mail_link_decision_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_link_decision" ADD CONSTRAINT "mail_link_decision_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Paul's confirm-queue decisions are append-only (NS-262, ADR-0012): a decision is a row, never an
-- edit. Reuses the Approval Gate's reject function (migration 0016), then grants the app role by
-- the NS-212 rule (migration 0065).
CREATE TRIGGER mail_link_decision_no_update_or_delete
  BEFORE UPDATE OR DELETE ON mail_link_decision
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_link_decision_no_truncate
  BEFORE TRUNCATE ON mail_link_decision
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();
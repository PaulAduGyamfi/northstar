CREATE TABLE "mail_classification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"outcome" text NOT NULL,
	"kind" text,
	"stage_signal" text,
	"decided_by" text NOT NULL,
	"review_reason" text,
	"prompt_version" integer,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_classification_one_per_message" UNIQUE("candidate_id","gmail_message_id"),
	CONSTRAINT "mail_classification_gmail_id_shape" CHECK ("mail_classification"."gmail_message_id" ~ '^[0-9a-f]{1,32}$'),
	CONSTRAINT "mail_classification_decided_by_valid" CHECK ("mail_classification"."decided_by" in ('rules', 'model')),
	CONSTRAINT "mail_classification_shape" CHECK (("mail_classification"."outcome" = 'classified' and "mail_classification"."kind" is not null and "mail_classification"."kind" in ('confirmation', 'rejection', 'assessment', 'interview_request', 'scheduling', 'recruiter_inbound', 'follow_up_needed', 'offer', 'info_other')
            and "mail_classification"."stage_signal" is not null and "mail_classification"."stage_signal" in ('none', 'screen', 'technical', 'onsite', 'offer')
            and "mail_classification"."review_reason" is null)
        or ("mail_classification"."outcome" = 'review' and "mail_classification"."kind" is null and "mail_classification"."stage_signal" is null
            and "mail_classification"."review_reason" is not null
            and "mail_classification"."review_reason" in ('refused', 'truncated', 'invalid_output', 'ambiguous', 'provenance')
            and "mail_classification"."decided_by" = 'model')),
	CONSTRAINT "mail_classification_prompt_version" CHECK (("mail_classification"."decided_by" = 'model' and "mail_classification"."prompt_version" is not null and "mail_classification"."prompt_version" between 1 and 9999)
        or ("mail_classification"."decided_by" = 'rules' and "mail_classification"."prompt_version" is null))
);
--> statement-breakpoint
ALTER TABLE "mail_classification" ADD CONSTRAINT "mail_classification_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Mail classifications are append-only (NS-261, ADR-0012): a decision is a row, never an edit.
-- Reuses the Approval Gate's reject function (migration 0016), then grants the app role by the
-- NS-212 rule (migration 0065).
CREATE TRIGGER mail_classification_no_update_or_delete
  BEFORE UPDATE OR DELETE ON mail_classification
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_classification_no_truncate
  BEFORE TRUNCATE ON mail_classification
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

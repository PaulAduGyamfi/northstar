CREATE TABLE "funnel_manual_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"line" integer NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"applied_on" text NOT NULL,
	"stage_reached" text NOT NULL,
	"outcome" text NOT NULL,
	"outcome_on" text,
	"channel" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "funnel_manual_row_sha" CHECK ("funnel_manual_row"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "funnel_manual_row_applied_on" CHECK ("funnel_manual_row"."applied_on" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
	CONSTRAINT "funnel_manual_row_outcome_on" CHECK ("funnel_manual_row"."outcome_on" is null or "funnel_manual_row"."outcome_on" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
	CONSTRAINT "funnel_manual_row_stage" CHECK ("funnel_manual_row"."stage_reached" in ('applied', 'responded', 'screen', 'technical', 'onsite', 'offer')),
	CONSTRAINT "funnel_manual_row_outcome" CHECK ("funnel_manual_row"."outcome" in ('open', 'rejected', 'offer', 'ghosted', 'withdrawn')),
	CONSTRAINT "funnel_manual_row_channel" CHECK ("funnel_manual_row"."channel" is null or "funnel_manual_row"."channel" in ('cold', 'referral', 'outreach', 'recruiter_inbound'))
);
--> statement-breakpoint
CREATE TABLE "funnel_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"sender_domain" text,
	"received_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"kind" text,
	"company" text,
	"role" text,
	"requisition" text,
	"stage_signal" text,
	"classified_by" text,
	"review_reason" text,
	"prompt_version" integer,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_message_gmail_unique" UNIQUE("candidate_id","gmail_id"),
	CONSTRAINT "funnel_message_status_valid" CHECK ("funnel_message"."status" in ('not_job', 'classified', 'needs_review', 'discarded')),
	CONSTRAINT "funnel_message_kind_valid" CHECK ("funnel_message"."kind" is null or "funnel_message"."kind" in ('confirmation', 'rejection', 'assessment', 'interview_request', 'scheduling', 'recruiter_inbound', 'follow_up_needed', 'offer', 'info_other')),
	CONSTRAINT "funnel_message_stage_valid" CHECK ("funnel_message"."stage_signal" is null or "funnel_message"."stage_signal" in ('none', 'screen', 'technical', 'onsite', 'offer')),
	CONSTRAINT "funnel_message_by_valid" CHECK ("funnel_message"."classified_by" is null or "funnel_message"."classified_by" in ('rules', 'model', 'paul')),
	CONSTRAINT "funnel_message_reason_valid" CHECK ("funnel_message"."review_reason" is null or "funnel_message"."review_reason" in ('refused', 'truncated', 'invalid_output', 'provenance', 'ambiguous', 'unparseable')),
	CONSTRAINT "funnel_message_classified_complete" CHECK ("funnel_message"."status" <> 'classified' or ("funnel_message"."kind" is not null and "funnel_message"."company" is not null and "funnel_message"."classified_by" is not null)),
	CONSTRAINT "funnel_message_review_has_reason" CHECK ("funnel_message"."status" <> 'needs_review' or "funnel_message"."review_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "funnel_manual_row" ADD CONSTRAINT "funnel_manual_row_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_message" ADD CONSTRAINT "funnel_message_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_manual_row_one_active_line" ON "funnel_manual_row" USING btree ("candidate_id","line") WHERE "funnel_manual_row"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "funnel_message_thread" ON "funnel_message" USING btree ("candidate_id","thread_id");

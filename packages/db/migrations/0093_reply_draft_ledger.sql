CREATE TABLE "reply_draft_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_draft_claim_one_per_attempt" UNIQUE("candidate_id","decision_id","attempt"),
	CONSTRAINT "reply_draft_claim_attempt_range" CHECK ("reply_draft_claim"."attempt" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "reply_draft_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"draft_message_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_draft_record_one_per_decision" UNIQUE("candidate_id","decision_id"),
	CONSTRAINT "reply_draft_record_message_id_shape" CHECK ("reply_draft_record"."draft_message_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "reply_draft_claim" ADD CONSTRAINT "reply_draft_claim_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_draft_record" ADD CONSTRAINT "reply_draft_record_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;

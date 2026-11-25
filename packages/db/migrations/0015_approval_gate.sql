CREATE TABLE "approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text NOT NULL,
	"policy_set_id" uuid,
	"rule_name" text,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_decision_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "approval_decision_decision_valid" CHECK ("approval_decision"."decision" in ('approved', 'rejected')),
	CONSTRAINT "approval_decision_decided_by_valid" CHECK ("approval_decision"."decided_by" in ('user', 'policy')),
	CONSTRAINT "approval_decision_policy_fields" CHECK (("approval_decision"."decided_by" = 'policy' and "approval_decision"."decision" = 'approved' and "approval_decision"."policy_set_id" is not null and "approval_decision"."rule_name" is not null)
        or ("approval_decision"."decided_by" = 'user' and "approval_decision"."policy_set_id" is null and "approval_decision"."rule_name" is null)),
	CONSTRAINT "approval_decision_reject_has_reason" CHECK ("approval_decision"."decision" <> 'rejected' or ("approval_decision"."reason" is not null and length(trim("approval_decision"."reason")) > 0)),
	CONSTRAINT "approval_decision_effective_after_decided" CHECK ("approval_decision"."effective_at" >= "approval_decision"."decided_at")
);
--> statement-breakpoint
CREATE TABLE "approval_policy_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" bigint GENERATED ALWAYS AS IDENTITY (sequence name "approval_policy_set_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_policy_set_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "approval_policy_set_rules_array" CHECK (jsonb_typeof("approval_policy_set"."rules") = 'array')
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"facts" jsonb,
	"actor" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_request_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "approval_request_idempotency_unique" UNIQUE("candidate_id","idempotency_key"),
	CONSTRAINT "approval_request_kind_valid" CHECK ("approval_request"."kind" in ('application_package', 'answer', 'email_reply', 'outreach', 'profile_fix', 'growth_plan', 'prep_plan')),
	CONSTRAINT "approval_request_subject_format" CHECK ("approval_request"."subject" ~ '^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "approval_undo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"undone_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_undo_one_per_decision" UNIQUE("decision_id")
);
--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id") REFERENCES "public"."approval_request"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_policy_set_same_candidate_fk" FOREIGN KEY ("policy_set_id","candidate_id") REFERENCES "public"."approval_policy_set"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policy_set" ADD CONSTRAINT "approval_policy_set_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_undo" ADD CONSTRAINT "approval_undo_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_undo" ADD CONSTRAINT "approval_undo_decision_same_candidate_fk" FOREIGN KEY ("decision_id","candidate_id") REFERENCES "public"."approval_decision"("id","candidate_id") ON DELETE no action ON UPDATE no action;
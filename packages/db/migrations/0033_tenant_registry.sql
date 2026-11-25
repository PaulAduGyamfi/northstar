CREATE TABLE "employer_tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
	"ats" text NOT NULL,
	"tenant_url" text NOT NULL,
	"account_email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "employer_tenant_one_per_key" UNIQUE("candidate_id","tenant_key"),
	CONSTRAINT "employer_tenant_key_valid" CHECK ("employer_tenant"."tenant_key" ~ '^[a-z0-9]+:[a-z0-9]+([_.-][a-z0-9]+)*$'),
	CONSTRAINT "employer_tenant_ats_matches_key" CHECK ("employer_tenant"."ats" = split_part("employer_tenant"."tenant_key", ':', 1)),
	CONSTRAINT "employer_tenant_url_https" CHECK ("employer_tenant"."tenant_url" ~ '^https://[^\s]+$'),
	CONSTRAINT "employer_tenant_url_length" CHECK (length("employer_tenant"."tenant_url") <= 2048),
	CONSTRAINT "employer_tenant_email_shape" CHECK ("employer_tenant"."account_email" ~ '^[^\s@]+@[^\s@]+$' and length("employer_tenant"."account_email") <= 320)
);
--> statement-breakpoint
CREATE TABLE "tenant_account_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "tenant_account_status_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_account_status_position_unique" UNIQUE("position"),
	CONSTRAINT "tenant_account_status_from_valid" CHECK (from_status in ('none', 'creating', 'verifying', 'active', 'locked', 'needs_human')),
	CONSTRAINT "tenant_account_status_to_valid" CHECK (to_status in ('none', 'creating', 'verifying', 'active', 'locked', 'needs_human')),
	CONSTRAINT "tenant_account_status_reason_valid" CHECK ("tenant_account_status"."reason" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "tenant_account_status_actor_valid" CHECK ("tenant_account_status"."actor" in ('user', 'agent:apply'))
);
--> statement-breakpoint
CREATE TABLE "consent_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "consent_policy_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"policy" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_policy_position_unique" UNIQUE("position"),
	CONSTRAINT "consent_policy_valid" CHECK (policy in ('auto', 'ask_per_tenant'))
);
--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"notice_url" text NOT NULL,
	"text_sha256" text NOT NULL,
	"text" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_record_kind_valid" CHECK ("consent_record"."kind" in ('terms', 'privacy')),
	CONSTRAINT "consent_record_url_https" CHECK ("consent_record"."notice_url" ~ '^https://[^\s]+$'),
	CONSTRAINT "consent_record_url_length" CHECK (length("consent_record"."notice_url") <= 2048),
	CONSTRAINT "consent_record_sha256_hex" CHECK ("consent_record"."text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consent_record_text_length" CHECK (length(text) between 1 and 200000),
	CONSTRAINT "consent_record_sha256_matches" CHECK ("consent_record"."text_sha256" = encode(sha256(convert_to("consent_record"."text", 'UTF8')), 'hex'))
);
--> statement-breakpoint
ALTER TABLE "employer_tenant" ADD CONSTRAINT "employer_tenant_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_account_status" ADD CONSTRAINT "tenant_account_status_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_account_status" ADD CONSTRAINT "tenant_account_status_tenant_id_employer_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."employer_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_policy" ADD CONSTRAINT "consent_policy_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_tenant_id_employer_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."employer_tenant"("id") ON DELETE no action ON UPDATE no action;

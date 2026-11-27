CREATE TABLE "company_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "company_domain_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_domain_position_unique" UNIQUE("position"),
	CONSTRAINT "company_domain_domain_shape" CHECK (length("company_domain"."domain") BETWEEN 3 AND 253 AND "company_domain"."domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
	CONSTRAINT "company_domain_action_valid" CHECK ("company_domain"."action" in ('add', 'remove')),
	CONSTRAINT "company_domain_source_valid" CHECK ("company_domain"."source" in ('paul'))
);
--> statement-breakpoint
ALTER TABLE "company_domain" ADD CONSTRAINT "company_domain_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_domain" ADD CONSTRAINT "company_domain_company_same_candidate_fk" FOREIGN KEY ("company_id","candidate_id") REFERENCES "public"."company"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A company's mail domains are append-only (NS-252, ADR-0012): a change is a new row, never an
-- edit. Reuses the Approval Gate's reject function (migration 0016), then grants the app role by
-- the NS-212 rule (migration 0065).
CREATE TRIGGER company_domain_no_update_or_delete
  BEFORE UPDATE OR DELETE ON company_domain
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER company_domain_no_truncate
  BEFORE TRUNCATE ON company_domain
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

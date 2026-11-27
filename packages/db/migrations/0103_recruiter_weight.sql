CREATE TABLE "recruiter_weight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "recruiter_weight_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"reasons" text[] NOT NULL,
	"adjustments" integer[] NOT NULL,
	"regrades" integer NOT NULL,
	"learned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recruiter_weight_position_unique" UNIQUE("position"),
	CONSTRAINT "recruiter_weight_reasons_listed" CHECK (array_position("recruiter_weight"."reasons", null) is null and "recruiter_weight"."reasons" <@ array['title:exact', 'title:partial', 'title:none', 'title:unknown', 'title:level_mismatch', 'pay:ok', 'pay:below', 'pay:unknown', 'place:ok', 'place:mismatch', 'place:unknown', 'sender:agency', 'sender:in_house', 'sender:unknown', 'personal:yes', 'personal:no', 'company:named', 'company:unnamed']::text[]),
	CONSTRAINT "recruiter_weight_adjustments_bounded" CHECK (cardinality("recruiter_weight"."adjustments") = cardinality("recruiter_weight"."reasons") and array_position("recruiter_weight"."adjustments", null) is null and "recruiter_weight"."adjustments" <@ array[-2, -1, 1, 2]),
	CONSTRAINT "recruiter_weight_regrades_count" CHECK ("recruiter_weight"."regrades" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recruiter_weight" ADD CONSTRAINT "recruiter_weight_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recruiter_weight_candidate" ON "recruiter_weight" USING btree ("candidate_id","position");--> statement-breakpoint
-- Learned recruiter weights are append-only (NS-238 item 3 slice 2, ADR-0012): a change is a new
-- version. Reuses the Approval Gate's reject function (migration 0016), then grants the app role
-- by the NS-212 rule (migration 0065).
CREATE TRIGGER recruiter_weight_no_update_or_delete
  BEFORE UPDATE OR DELETE ON recruiter_weight
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER recruiter_weight_no_truncate
  BEFORE TRUNCATE ON recruiter_weight
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

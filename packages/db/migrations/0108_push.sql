CREATE TABLE "push_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_notification_once" UNIQUE("candidate_id","item_key"),
	CONSTRAINT "push_notification_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "push_notification_item_key_shape" CHECK ("push_notification"."item_key" ~ '^apply_handoff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:notify$')
);
--> statement-breakpoint
CREATE TABLE "push_notification_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"sent_count" integer NOT NULL,
	"gone_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_notification_result_once" UNIQUE("notification_id"),
	CONSTRAINT "push_notification_result_outcome_valid" CHECK ("push_notification_result"."outcome" in ('sent', 'failed')),
	CONSTRAINT "push_notification_result_counts" CHECK ("push_notification_result"."sent_count" >= 0 AND "push_notification_result"."gone_count" >= 0 AND "push_notification_result"."rejected_count" >= 0 AND ("push_notification_result"."outcome" = 'sent') = ("push_notification_result"."sent_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "push_subscription_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_position_unique" UNIQUE("position"),
	CONSTRAINT "push_subscription_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "push_subscription_endpoint_shape" CHECK (length("push_subscription"."endpoint") <= 1024 AND "push_subscription"."endpoint" ~ '^https://[^\s]+$'),
	CONSTRAINT "push_subscription_p256dh_shape" CHECK ("push_subscription"."p256dh" ~ '^B[A-Za-z0-9_-]{86}$'),
	CONSTRAINT "push_subscription_auth_shape" CHECK ("push_subscription"."auth" ~ '^[A-Za-z0-9_-]{22}$')
);
--> statement-breakpoint
CREATE TABLE "push_subscription_removal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_removal_once" UNIQUE("subscription_id"),
	CONSTRAINT "push_subscription_removal_reason_valid" CHECK ("push_subscription_removal"."reason" in ('user', 'gone'))
);
--> statement-breakpoint
ALTER TABLE "kill_switch" DROP CONSTRAINT "kill_switch_subsystem_valid";--> statement-breakpoint
ALTER TABLE "push_notification" ADD CONSTRAINT "push_notification_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notification_result" ADD CONSTRAINT "push_notification_result_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notification_result" ADD CONSTRAINT "push_notification_result_same_candidate_fk" FOREIGN KEY ("notification_id","candidate_id") REFERENCES "public"."push_notification"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription_removal" ADD CONSTRAINT "push_subscription_removal_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription_removal" ADD CONSTRAINT "push_subscription_removal_same_candidate_fk" FOREIGN KEY ("subscription_id","candidate_id") REFERENCES "public"."push_subscription"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switch" ADD CONSTRAINT "kill_switch_subsystem_valid" CHECK ("kill_switch"."subsystem" ~ '^(auto_apply|outreach_send|inbox_auto_label|vault|push|(source|adapter|agent):[a-z0-9]+([_.-][a-z0-9]+)*)$');
--> statement-breakpoint
-- Web push subscriptions, removals, notification claims and results are append-only (NS-193, ADR-0032, ADR-0012): a change is a new row, never an edit. Reuses the Approval Gate's reject function (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER push_subscription_no_update_or_delete BEFORE UPDATE OR DELETE ON push_subscription FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_subscription_no_truncate BEFORE TRUNCATE ON push_subscription FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_subscription_removal_no_update_or_delete BEFORE UPDATE OR DELETE ON push_subscription_removal FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_subscription_removal_no_truncate BEFORE TRUNCATE ON push_subscription_removal FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_notification_no_update_or_delete BEFORE UPDATE OR DELETE ON push_notification FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_notification_no_truncate BEFORE TRUNCATE ON push_notification FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_notification_result_no_update_or_delete BEFORE UPDATE OR DELETE ON push_notification_result FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER push_notification_result_no_truncate BEFORE TRUNCATE ON push_notification_result FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

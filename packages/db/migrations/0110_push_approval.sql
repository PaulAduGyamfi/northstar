ALTER TABLE "push_notification" DROP CONSTRAINT "push_notification_item_key_shape";--> statement-breakpoint
ALTER TABLE "push_notification" ADD CONSTRAINT "push_notification_item_key_shape" CHECK ("push_notification"."item_key" ~ '^(apply_handoff|job_fresh_alert|approval_request):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:notify$');

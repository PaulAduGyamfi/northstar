ALTER TABLE "approval_request" DROP CONSTRAINT "approval_request_kind_valid";--> statement-breakpoint
ALTER TABLE "vault_access" DROP CONSTRAINT "vault_access_actor_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "vault_access_reveal_once" ON "vault_access" USING btree ("decision_id") WHERE "vault_access"."purpose" = 'reveal_to_user';--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_kind_valid" CHECK ("approval_request"."kind" in ('application_package', 'answer', 'email_reply', 'outreach', 'profile_fix', 'growth_plan', 'prep_plan', 'vault_reveal'));--> statement-breakpoint
ALTER TABLE "vault_access" ADD CONSTRAINT "vault_access_actor_valid" CHECK (("vault_access"."actor" ~ '^agent:[a-z0-9-]+$' and "vault_access"."purpose" <> 'reveal_to_user') or ("vault_access"."actor" = 'user' and "vault_access"."purpose" = 'reveal_to_user'));

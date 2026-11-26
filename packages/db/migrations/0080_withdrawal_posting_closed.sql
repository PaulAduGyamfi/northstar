ALTER TABLE "approval_withdrawal" DROP CONSTRAINT "approval_withdrawal_by_valid";--> statement-breakpoint
ALTER TABLE "approval_withdrawal" DROP CONSTRAINT "approval_withdrawal_reason_valid";--> statement-breakpoint
ALTER TABLE "approval_withdrawal" DROP CONSTRAINT "approval_withdrawal_reason_matches_by";--> statement-breakpoint
ALTER TABLE "approval_withdrawal" ADD CONSTRAINT "approval_withdrawal_by_valid" CHECK ("approval_withdrawal"."withdrawn_by" in ('user', 'gateway', 'system'));--> statement-breakpoint
ALTER TABLE "approval_withdrawal" ADD CONSTRAINT "approval_withdrawal_reason_valid" CHECK ("approval_withdrawal"."reason" in ('paul', 'content_changed', 'posting_closed'));--> statement-breakpoint
ALTER TABLE "approval_withdrawal" ADD CONSTRAINT "approval_withdrawal_reason_matches_by" CHECK (("approval_withdrawal"."withdrawn_by" = 'user' and "approval_withdrawal"."reason" = 'paul') or ("approval_withdrawal"."withdrawn_by" = 'gateway' and "approval_withdrawal"."reason" = 'content_changed') or ("approval_withdrawal"."withdrawn_by" = 'system' and "approval_withdrawal"."reason" = 'posting_closed'));

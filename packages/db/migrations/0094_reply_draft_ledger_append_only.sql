-- The Gmail draft writer's ledger is append-only (NS-237 slice 6, ADR-0012, ADR-0025 item 5): a
-- claim or a recorded draft is never edited or removed, so one approval can only ever make one
-- draft. Reuses the Approval Gate's reject function (migration 0016), then grants the app role by
-- the NS-212 rule (migration 0065).
CREATE TRIGGER reply_draft_claim_no_update_or_delete
  BEFORE UPDATE OR DELETE ON reply_draft_claim
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER reply_draft_claim_no_truncate
  BEFORE TRUNCATE ON reply_draft_claim
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER reply_draft_record_no_update_or_delete
  BEFORE UPDATE OR DELETE ON reply_draft_record
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER reply_draft_record_no_truncate
  BEFORE TRUNCATE ON reply_draft_record
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

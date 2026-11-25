-- Human handoffs are append-only (NS-121, APPLY-006): a handoff records that a challenge stopped
-- a submission, and its outcome records what Paul did. A correction is a new record elsewhere,
-- never an edit (ADR-0012). Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER apply_handoff_no_update_or_delete
  BEFORE UPDATE OR DELETE ON apply_handoff
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER apply_handoff_no_truncate
  BEFORE TRUNCATE ON apply_handoff
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER apply_handoff_done_no_update_or_delete
  BEFORE UPDATE OR DELETE ON apply_handoff_done
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER apply_handoff_done_no_truncate
  BEFORE TRUNCATE ON apply_handoff_done
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

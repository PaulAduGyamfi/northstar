-- Posting checks are append-only (NS-173, SRC-010, ADR-0012): each re-check is a new row and the
-- newest per job is its state. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER posting_check_no_update_or_delete
  BEFORE UPDATE OR DELETE ON posting_check
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER posting_check_no_truncate
  BEFORE TRUNCATE ON posting_check
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

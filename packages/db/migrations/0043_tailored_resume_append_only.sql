-- Tailored resume versions are append-only (NS-146, TLR-005, ADR-0012): a new version is a new
-- row, never an edit. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER tailored_resume_no_update_or_delete
  BEFORE UPDATE OR DELETE ON tailored_resume
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER tailored_resume_no_truncate
  BEFORE TRUNCATE ON tailored_resume
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

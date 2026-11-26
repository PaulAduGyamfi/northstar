-- Paul's independent-work entries are append-only (NS-196, ADR-0012): a changed file is a new
-- version, never an edit. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER independent_work_set_no_update_or_delete
  BEFORE UPDATE OR DELETE ON independent_work_set
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER independent_work_set_no_truncate
  BEFORE TRUNCATE ON independent_work_set
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER independent_work_entry_no_update_or_delete
  BEFORE UPDATE OR DELETE ON independent_work_entry
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER independent_work_entry_no_truncate
  BEFORE TRUNCATE ON independent_work_entry
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER independent_work_line_no_update_or_delete
  BEFORE UPDATE OR DELETE ON independent_work_line
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER independent_work_line_no_truncate
  BEFORE TRUNCATE ON independent_work_line
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

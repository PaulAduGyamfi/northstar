-- Resume audits, their suggestions, Paul's decisions and his edited lines are append-only
-- (NS-190, ADR-0012): a new run, decision or line is a new row, never an edit. Reuses the
-- Approval Gate's reject function (migration 0016).
CREATE TRIGGER resume_audit_no_update_or_delete
  BEFORE UPDATE OR DELETE ON resume_audit
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER resume_audit_no_truncate
  BEFORE TRUNCATE ON resume_audit
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER resume_audit_suggestion_no_update_or_delete
  BEFORE UPDATE OR DELETE ON resume_audit_suggestion
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER resume_audit_suggestion_no_truncate
  BEFORE TRUNCATE ON resume_audit_suggestion
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER resume_audit_decision_no_update_or_delete
  BEFORE UPDATE OR DELETE ON resume_audit_decision
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER resume_audit_decision_no_truncate
  BEFORE TRUNCATE ON resume_audit_decision
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER atom_line_edit_no_update_or_delete
  BEFORE UPDATE OR DELETE ON atom_line_edit
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER atom_line_edit_no_truncate
  BEFORE TRUNCATE ON atom_line_edit
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

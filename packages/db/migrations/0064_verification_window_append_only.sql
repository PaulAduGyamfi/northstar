-- Verification windows are append-only (NS-151, ADR-0012): a resend, a close or a used message is a
-- new row, never an edit. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER verification_window_no_update_or_delete
  BEFORE UPDATE OR DELETE ON verification_window
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_window_no_truncate
  BEFORE TRUNCATE ON verification_window
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_window_restart_no_update_or_delete
  BEFORE UPDATE OR DELETE ON verification_window_restart
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_window_restart_no_truncate
  BEFORE TRUNCATE ON verification_window_restart
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_window_close_no_update_or_delete
  BEFORE UPDATE OR DELETE ON verification_window_close
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_window_close_no_truncate
  BEFORE TRUNCATE ON verification_window_close
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_used_message_no_update_or_delete
  BEFORE UPDATE OR DELETE ON verification_used_message
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER verification_used_message_no_truncate
  BEFORE TRUNCATE ON verification_used_message
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

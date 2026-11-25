-- Mail tags and links are append-only (NS-158, VER-007, INB-009). A tag, once given, keeps
-- routing its mail; a link records what matching decided for one message, and a correction is a
-- new decision elsewhere, never an edit (ADR-0012). Reuses the Approval Gate's reject function
-- (migration 0016).
CREATE TRIGGER mail_tag_no_update_or_delete
  BEFORE UPDATE OR DELETE ON mail_tag
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_tag_no_truncate
  BEFORE TRUNCATE ON mail_tag
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_link_no_update_or_delete
  BEFORE UPDATE OR DELETE ON mail_link
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_link_no_truncate
  BEFORE TRUNCATE ON mail_link
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

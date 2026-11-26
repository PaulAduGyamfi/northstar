-- Profile settings are append-only (NS-141, ANS-001, ADR-0012): each change is a new row and the
-- newest row per field and qualifier is the value. Reuses the Approval Gate's reject function
-- (migration 0016).
CREATE TRIGGER profile_setting_no_update_or_delete
  BEFORE UPDATE OR DELETE ON profile_setting
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER profile_setting_no_truncate
  BEFORE TRUNCATE ON profile_setting
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

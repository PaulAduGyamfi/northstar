-- Stored files are append-only (NS-227, ADR-0012): an approved package names a file by its hash,
-- so the bytes behind a hash never change or go away. Reuses the Approval Gate's reject function
-- (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER stored_file_no_update_or_delete
  BEFORE UPDATE OR DELETE ON stored_file
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER stored_file_no_truncate
  BEFORE TRUNCATE ON stored_file
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

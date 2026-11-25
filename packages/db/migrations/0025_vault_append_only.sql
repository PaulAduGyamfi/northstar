-- The credential vault is append-only (NS-122, ADR-0010, CRD-001/003). A stored secret version
-- is never rewritten or removed (rotation adds a version), and the decrypt audit can't be edited
-- or emptied. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER vault_secret_no_update_or_delete
  BEFORE UPDATE OR DELETE ON vault_secret
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER vault_secret_no_truncate
  BEFORE TRUNCATE ON vault_secret
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER vault_access_no_update_or_delete
  BEFORE UPDATE OR DELETE ON vault_access
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER vault_access_no_truncate
  BEFORE TRUNCATE ON vault_access
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

-- The tenant registry and consent records are append-only (NS-124, ACC-001, ACC-006, ACC-008):
-- a tenant is registered once, an account's status changes by a new row, and an accepted notice
-- or a policy change is never edited (ADR-0012). Reuses the Approval Gate's reject function
-- (migration 0016). SELECT ... FOR UPDATE still works: it locks the row, it doesn't change it.
CREATE TRIGGER employer_tenant_no_update_or_delete
  BEFORE UPDATE OR DELETE ON employer_tenant
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER employer_tenant_no_truncate
  BEFORE TRUNCATE ON employer_tenant
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER tenant_account_status_no_update_or_delete
  BEFORE UPDATE OR DELETE ON tenant_account_status
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER tenant_account_status_no_truncate
  BEFORE TRUNCATE ON tenant_account_status
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER consent_policy_no_update_or_delete
  BEFORE UPDATE OR DELETE ON consent_policy
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER consent_policy_no_truncate
  BEFORE TRUNCATE ON consent_policy
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER consent_record_no_update_or_delete
  BEFORE UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER consent_record_no_truncate
  BEFORE TRUNCATE ON consent_record
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

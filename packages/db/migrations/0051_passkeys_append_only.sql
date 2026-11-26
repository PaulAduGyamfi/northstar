-- Passkeys are append-only (NS-178, ADR-0022): a registered credential is never edited or deleted,
-- and each sign-in adds a use, so a sign count can only be added, never rewritten. Reuses the
-- Approval Gate's reject function (migration 0016).
CREATE TRIGGER passkey_credential_no_update_or_delete
  BEFORE UPDATE OR DELETE ON passkey_credential
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER passkey_credential_no_truncate
  BEFORE TRUNCATE ON passkey_credential
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER passkey_use_no_update_or_delete
  BEFORE UPDATE OR DELETE ON passkey_use
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER passkey_use_no_truncate
  BEFORE TRUNCATE ON passkey_use
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

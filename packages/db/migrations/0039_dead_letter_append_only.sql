-- Dead letters and their resolutions are append-only (NS-175, RES-007, ADR-0012): a letter is
-- recorded once and resolved once, never edited or removed. Reuses the Approval Gate's reject
-- function (migration 0016).
CREATE TRIGGER dead_letter_no_update_or_delete
  BEFORE UPDATE OR DELETE ON dead_letter
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER dead_letter_no_truncate
  BEFORE TRUNCATE ON dead_letter
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER dead_letter_resolution_no_update_or_delete
  BEFORE UPDATE OR DELETE ON dead_letter_resolution
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER dead_letter_resolution_no_truncate
  BEFORE TRUNCATE ON dead_letter_resolution
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

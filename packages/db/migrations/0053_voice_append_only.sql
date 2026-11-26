-- The voice profile is append-only (NS-185, ANS-007/008): a measured version, Paul's review of it
-- and each edit's deleted phrases are never changed or removed; a newer row supersedes. Reuses
-- the Approval Gate's reject function (migration 0016).
CREATE TRIGGER voice_profile_no_update_or_delete
  BEFORE UPDATE OR DELETE ON voice_profile
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER voice_profile_no_truncate
  BEFORE TRUNCATE ON voice_profile
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER voice_review_no_update_or_delete
  BEFORE UPDATE OR DELETE ON voice_review
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER voice_review_no_truncate
  BEFORE TRUNCATE ON voice_review
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER voice_edit_no_update_or_delete
  BEFORE UPDATE OR DELETE ON voice_edit
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER voice_edit_no_truncate
  BEFORE TRUNCATE ON voice_edit
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

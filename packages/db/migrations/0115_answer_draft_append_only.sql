-- Answer drafts are append-only (NS-281 slice 3, ADR-0012): what Paul approved is never edited; a
-- changed draft is a new Gate request and a new row. Reuses the Approval Gate's reject function
-- (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER answer_draft_no_update_or_delete
  BEFORE UPDATE OR DELETE ON answer_draft
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER answer_draft_no_truncate
  BEFORE TRUNCATE ON answer_draft
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

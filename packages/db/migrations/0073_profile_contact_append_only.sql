-- Paul's contact details are append-only (NS-227, ADR-0012): a change is a new row, never an
-- edit. Reuses the Approval Gate's reject function (migration 0016), then grants the app role by
-- the NS-212 rule (migration 0065).
CREATE TRIGGER profile_contact_no_update_or_delete
  BEFORE UPDATE OR DELETE ON profile_contact
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER profile_contact_no_truncate
  BEFORE TRUNCATE ON profile_contact
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

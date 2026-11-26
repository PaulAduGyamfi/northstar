-- Job forms are append-only (NS-227, ADR-0012): a changed form is a new row, never an edit.
-- Reuses the Approval Gate's reject function (migration 0016), then grants the app role by the
-- NS-212 rule (migration 0065).
CREATE TRIGGER job_form_no_update_or_delete
  BEFORE UPDATE OR DELETE ON job_form
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER job_form_no_truncate
  BEFORE TRUNCATE ON job_form
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

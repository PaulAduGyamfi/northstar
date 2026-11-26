-- Recruiter grades are append-only (NS-238, ADR-0012): a grade is recorded once per message; a
-- regrade (REC-003) will be its own row in a later table. Reuses the Approval Gate's reject function
-- (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER recruiter_grade_no_update_or_delete
  BEFORE UPDATE OR DELETE ON recruiter_grade
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER recruiter_grade_no_truncate
  BEFORE TRUNCATE ON recruiter_grade
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

-- Detected interviews and Paul's decisions are append-only (NS-240 slice 2, ADR-0012): a reschedule
-- is a new detection row and a decision is made once. Reuses the Approval Gate's reject function
-- (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER interview_detection_no_update_or_delete
  BEFORE UPDATE OR DELETE ON interview_detection
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_detection_no_truncate
  BEFORE TRUNCATE ON interview_detection
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_decision_no_update_or_delete
  BEFORE UPDATE OR DELETE ON interview_decision
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER interview_decision_no_truncate
  BEFORE TRUNCATE ON interview_decision
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

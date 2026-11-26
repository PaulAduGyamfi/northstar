-- Check-ins and weekly reviews are append-only (NS-214, ADR-0012): a new check-in or review is a
-- new row, never an edit. Reuses the Approval Gate's reject function (migration 0016), then grants
-- the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER growth_check_in_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_check_in
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_check_in_no_truncate
  BEFORE TRUNCATE ON growth_check_in
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_review_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_review
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_review_no_truncate
  BEFORE TRUNCATE ON growth_review
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

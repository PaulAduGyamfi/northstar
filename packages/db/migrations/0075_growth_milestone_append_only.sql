-- Growth milestones are append-only (NS-232, ADR-0012), like the rest of the growth tables
-- (migration 0062): a changed tracks file is a new version, never an edit. Reuses the Approval
-- Gate's reject function (migration 0016), then grants the app role by the NS-212 rule
-- (migration 0065).
CREATE TRIGGER growth_milestone_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_milestone
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_milestone_no_truncate
  BEFORE TRUNCATE ON growth_milestone
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();

-- The growth tracker's tables are append-only (NS-210, ADR-0012): a changed tracks file, a touch,
-- new settings or a week's plan is a new row, never an edit. Reuses the Approval Gate's reject
-- function (migration 0016).
CREATE TRIGGER growth_track_set_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_track_set
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_track_set_no_truncate
  BEFORE TRUNCATE ON growth_track_set
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_track_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_track
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_track_no_truncate
  BEFORE TRUNCATE ON growth_track
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_touch_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_touch
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_touch_no_truncate
  BEFORE TRUNCATE ON growth_touch
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_settings_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_settings
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_settings_no_truncate
  BEFORE TRUNCATE ON growth_settings
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_plan_no_update_or_delete
  BEFORE UPDATE OR DELETE ON growth_plan
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER growth_plan_no_truncate
  BEFORE TRUNCATE ON growth_plan
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

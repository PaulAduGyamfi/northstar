-- Kill switches are append-only (NS-126, RES-008): each flip is a new row, so the feed and the
-- audit trail keep every change. The newest row per subsystem is its state.
CREATE FUNCTION kill_switch_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER kill_switch_no_update_or_delete
  BEFORE UPDATE OR DELETE ON kill_switch
  FOR EACH ROW EXECUTE FUNCTION kill_switch_reject_change();
--> statement-breakpoint
CREATE TRIGGER kill_switch_no_truncate
  BEFORE TRUNCATE ON kill_switch
  FOR EACH STATEMENT EXECUTE FUNCTION kill_switch_reject_change();

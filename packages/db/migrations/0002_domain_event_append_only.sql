-- domain_event is append-only (ADR-0012, .claude/rules/db.md). A wrong event is corrected by
-- appending another one, never by editing or deleting history.
CREATE FUNCTION domain_event_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'domain_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER domain_event_no_update_or_delete
  BEFORE UPDATE OR DELETE ON domain_event
  FOR EACH ROW EXECUTE FUNCTION domain_event_reject_change();
--> statement-breakpoint
CREATE TRIGGER domain_event_no_truncate
  BEFORE TRUNCATE ON domain_event
  FOR EACH STATEMENT EXECUTE FUNCTION domain_event_reject_change();

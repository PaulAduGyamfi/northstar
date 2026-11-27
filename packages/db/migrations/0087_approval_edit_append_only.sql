-- Edited requests (NS-203, APR-002). approval_edit is append-only, its time comes from the Gate's
-- clock, and the database checks the link itself: the old request was withdrawn by Paul, and the
-- new one has the same kind and subject (an edit replaces what one subject would let out). Its
-- refusals raise integrity_constraint_violation, not check_violation: editRequest reads a
-- check_violation as a race (the request was decided meanwhile), and a broken link must surface as
-- an error instead.
CREATE TRIGGER approval_edit_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_edit
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_edit_no_truncate
  BEFORE TRUNCATE ON approval_edit
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE FUNCTION approval_edit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev approval_request%ROWTYPE;
  next approval_request%ROWTYPE;
BEGIN
  SELECT * INTO prev FROM approval_request WHERE id = NEW.previous_request_id;
  SELECT * INTO next FROM approval_request WHERE id = NEW.request_id;
  IF NOT EXISTS (SELECT 1 FROM approval_withdrawal w
      WHERE w.request_id = NEW.previous_request_id AND w.withdrawn_by = 'user') THEN
    RAISE EXCEPTION 'an edit replaces a request Paul withdrew'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF prev.kind IS DISTINCT FROM next.kind OR prev.subject IS DISTINCT FROM next.subject THEN
    RAISE EXCEPTION 'an edit keeps the request''s kind and subject'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- An allowlist: only kinds with their own edit path that stores the edited content (reply
  -- drafts). Packages need their facts derived again, and a reveal never waits in the queue.
  IF next.kind <> 'email_reply' THEN
    RAISE EXCEPTION 'this kind of request cannot be edited'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.edited_at := northstar_gate_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_edit_checks
  BEFORE INSERT ON approval_edit
  FOR EACH ROW EXECUTE FUNCTION approval_edit_guard();
--> statement-breakpoint
SELECT northstar_grant_app_role();

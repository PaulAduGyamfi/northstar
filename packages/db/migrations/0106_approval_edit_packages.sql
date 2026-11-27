-- Paul edits a waiting application package too (NS-203 slice 4): approval_edit's allowlist adds
-- application_package beside email_reply. editRequest files an edited package only with the facts
-- the Gate derived for it (editPackage), and the rest of the guard is unchanged from 0087.
CREATE OR REPLACE FUNCTION approval_edit_guard() RETURNS trigger
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
  -- drafts, and packages with their facts derived again). A reveal never waits in the queue.
  IF next.kind NOT IN ('email_reply', 'application_package') THEN
    RAISE EXCEPTION 'this kind of request cannot be edited'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.edited_at := northstar_gate_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
SELECT northstar_grant_app_role();

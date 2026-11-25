-- The Approval Gate's database guards (APR-004, ADR-0017, .claude/rules/db.md).

-- One clock for the Gate: the database's. Every request, decision and undo is stamped by a
-- trigger below, and verifyApproval compares against it, so a caller's fast or slow clock can't
-- shorten or stretch the undo window. There is no override here on purpose: only the PGlite test
-- database replaces this function with a pinnable one (src/test/global-setup.ts).
-- The Gate's checks assume READ COMMITTED (the default): each check after a lock must see rows
-- other transactions committed while it waited.
CREATE FUNCTION northstar_gate_now() RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp()
$$;
--> statement-breakpoint
-- Approval records are immutable: a request, a policy set, a decision and an undo are each
-- written once and never changed or removed. A decision is taken back by appending an undo.
CREATE FUNCTION approval_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_request_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_request_no_truncate
  BEFORE TRUNCATE ON approval_request
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_policy_set_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_policy_set
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_policy_set_no_truncate
  BEFORE TRUNCATE ON approval_policy_set
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_decision_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_decision_no_truncate
  BEFORE TRUNCATE ON approval_decision
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_undo_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_undo
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_undo_no_truncate
  BEFORE TRUNCATE ON approval_undo
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
-- A subject is in the queue at most once at a time: a new request for it is refused while an
-- earlier one is pending (no live decision) or approved. So an agent can't ask again to get
-- around Paul's undo, and the queue holds no duplicates. After a rejection it may ask again
-- (e.g. with edited content); that request always waits for Paul (see below).
CREATE FUNCTION approval_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize requests for one subject; released when the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.candidate_id::text || NEW.subject, 0));
  IF EXISTS (
    SELECT 1 FROM approval_request r
    WHERE r.candidate_id = NEW.candidate_id AND r.subject = NEW.subject
      AND NOT EXISTS (
        SELECT 1 FROM approval_decision d
        WHERE d.request_id = r.id AND d.decision = 'rejected'
          AND NOT EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id)
      )
  ) THEN
    RAISE EXCEPTION 'this subject already has a pending or approved request'
      USING ERRCODE = 'exclusion_violation';
  END IF;
  NEW.requested_at := northstar_gate_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_request_one_open_per_subject
  BEFORE INSERT ON approval_request
  FOR EACH ROW EXECUTE FUNCTION approval_request_guard();
--> statement-breakpoint
-- Every decision:
-- * at most one live decision (one with no undo) per request; the request row is locked first,
--   so two racing decisions are serialized and the second is refused;
-- * a policy may only decide an application package, and never a subject Paul has rejected or
--   undone a decision on before (asking again must not route around him);
-- * its time and its undo window come from the database clock: 2 minutes, matching
--   UNDO_WINDOW_MS in packages/domain (a test checks they agree).
CREATE FUNCTION approval_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req approval_request%ROWTYPE;
BEGIN
  SELECT * INTO req FROM approval_request WHERE id = NEW.request_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM approval_decision d
    WHERE d.request_id = NEW.request_id
      AND NOT EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id)
  ) THEN
    RAISE EXCEPTION 'approval request already has a live decision'
      USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW.decided_by = 'policy' THEN
    IF req.kind <> 'application_package' THEN
      RAISE EXCEPTION 'only an application package can be approved by a policy'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_decision d ON d.request_id = r.id
      WHERE r.candidate_id = req.candidate_id AND r.subject = req.subject
        AND (d.decision = 'rejected'
          OR EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id))
    ) THEN
      RAISE EXCEPTION 'Paul rejected or undid this subject before; it waits for him'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.decided_at := northstar_gate_now();
  NEW.effective_at := NEW.decided_at + interval '2 minutes';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_decision_checks
  BEFORE INSERT ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_decision_guard();
--> statement-breakpoint
-- An undo:
-- * locks its decision row first; verifyApproval locks the same row, so an undo and a gateway's
--   check never overlap: whichever commits first wins, and the other sees it;
-- * is stamped by the database clock after that lock, and only possible inside the undo window;
-- * is refused while another request for the same subject is open (pending or approved), so
--   undoing an old rejection can't put two requests for one subject in the queue.
CREATE FUNCTION approval_undo_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dec approval_decision%ROWTYPE;
  req approval_request%ROWTYPE;
BEGIN
  SELECT * INTO dec FROM approval_decision WHERE id = NEW.decision_id FOR UPDATE;
  SELECT * INTO req FROM approval_request WHERE id = dec.request_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(req.candidate_id::text || req.subject, 0));
  NEW.undone_at := northstar_gate_now();
  IF dec.id IS NULL OR NEW.undone_at >= dec.effective_at THEN
    RAISE EXCEPTION 'the undo window for this decision has closed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM approval_request r
    WHERE r.candidate_id = req.candidate_id AND r.subject = req.subject AND r.id <> req.id
      AND NOT EXISTS (
        SELECT 1 FROM approval_decision d
        WHERE d.request_id = r.id AND d.decision = 'rejected'
          AND NOT EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id)
      )
  ) THEN
    RAISE EXCEPTION 'another request for this subject is open; this decision stands'
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_undo_within_window
  BEFORE INSERT ON approval_undo
  FOR EACH ROW EXECUTE FUNCTION approval_undo_guard();
--> statement-breakpoint
-- A policy set's time comes from the same clock.
CREATE FUNCTION approval_policy_set_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := northstar_gate_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_policy_set_stamped
  BEFORE INSERT ON approval_policy_set
  FOR EACH ROW EXECUTE FUNCTION approval_policy_set_stamp();

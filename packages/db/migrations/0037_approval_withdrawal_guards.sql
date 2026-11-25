-- The withdraw record (NS-140, APR-004). A withdrawn request is closed: not pending, not approved.
-- This migration (1) makes approval_withdrawal append-only and stamps its time from the Gate's
-- clock, (2) checks every withdrawal under the same locks an undo takes, and (3) teaches the
-- request, decision and undo guards of migration 0016 that a withdrawn request is closed.
CREATE TRIGGER approval_withdrawal_no_update_or_delete
  BEFORE UPDATE OR DELETE ON approval_withdrawal
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER approval_withdrawal_no_truncate
  BEFORE TRUNCATE ON approval_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
-- A withdrawal:
-- * locks the request's decision rows first (as an undo and verifyApproval do), then the request
--   row, then the subject; the same order as the other guards, so they serialize and never
--   deadlock;
-- * is refused for a request already closed by a live rejection;
-- * by a gateway, only closes a live approval past its undo window (the content-changed proof is
--   checked in code, where the new hash is known);
-- * is stamped by the database clock.
CREATE FUNCTION approval_withdrawal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req approval_request%ROWTYPE;
  live approval_decision%ROWTYPE;
BEGIN
  -- In id order, so two withdrawals racing on one request lock its decisions the same way.
  PERFORM 1 FROM approval_decision WHERE request_id = NEW.request_id ORDER BY id FOR UPDATE;
  SELECT * INTO req FROM approval_request WHERE id = NEW.request_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(req.candidate_id::text || req.subject, 0));
  SELECT d.* INTO live FROM approval_decision d
    WHERE d.request_id = NEW.request_id
      AND NOT EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id)
    FOR UPDATE;
  IF live.id IS NOT NULL AND live.decision = 'rejected' THEN
    RAISE EXCEPTION 'this request was rejected; it is already closed'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A gateway only meets changed content when it acts, which is after the undo window; inside
  -- the window the approval is still Paul's to undo, so a gateway may not close it first.
  IF NEW.withdrawn_by = 'gateway' AND (live.id IS NULL OR live.decision <> 'approved'
      OR live.effective_at > northstar_gate_now()) THEN
    RAISE EXCEPTION 'a gateway may only withdraw an approval that has taken effect'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.withdrawn_at := northstar_gate_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_withdrawal_checks
  BEFORE INSERT ON approval_withdrawal
  FOR EACH ROW EXECUTE FUNCTION approval_withdrawal_guard();
--> statement-breakpoint
-- Migration 0016's request guard, with withdrawn requests no longer counted as open.
CREATE OR REPLACE FUNCTION approval_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize requests for one subject; released when the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.candidate_id::text || NEW.subject, 0));
  IF EXISTS (
    SELECT 1 FROM approval_request r
    WHERE r.candidate_id = NEW.candidate_id AND r.subject = NEW.subject
      AND NOT EXISTS (SELECT 1 FROM approval_withdrawal w WHERE w.request_id = r.id)
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
-- Migration 0016's decision guard, plus: no decision on a withdrawn request, and a subject Paul
-- withdrew counts like one he rejected or undid (a policy may not approve it again).
CREATE OR REPLACE FUNCTION approval_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req approval_request%ROWTYPE;
BEGIN
  SELECT * INTO req FROM approval_request WHERE id = NEW.request_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM approval_withdrawal w WHERE w.request_id = NEW.request_id) THEN
    RAISE EXCEPTION 'this request was withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
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
    ) OR EXISTS (
      SELECT 1 FROM approval_request r
      JOIN approval_withdrawal w ON w.request_id = r.id
      WHERE r.candidate_id = req.candidate_id AND r.subject = req.subject
        AND w.withdrawn_by = 'user'
    ) THEN
      RAISE EXCEPTION 'Paul rejected, undid or withdrew this subject before; it waits for him'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.decided_at := northstar_gate_now();
  NEW.effective_at := NEW.decided_at + interval '2 minutes';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Migration 0016's undo guard, plus: no undo on a withdrawn request (it is already closed), and
-- withdrawn requests don't count as open when checking the subject.
CREATE OR REPLACE FUNCTION approval_undo_guard() RETURNS trigger
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
  IF EXISTS (SELECT 1 FROM approval_withdrawal w WHERE w.request_id = req.id) THEN
    RAISE EXCEPTION 'this request was withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM approval_request r
    WHERE r.candidate_id = req.candidate_id AND r.subject = req.subject AND r.id <> req.id
      AND NOT EXISTS (SELECT 1 FROM approval_withdrawal w WHERE w.request_id = r.id)
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

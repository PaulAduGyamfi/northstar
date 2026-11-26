-- NS-239: the system closes an application package's request when the job's posting closed. This
-- replaces migration 0037's withdrawal guard with the same locks and checks, plus one rule: a
-- `system` withdrawal applies only to an application_package request (the CHECKs pair it with
-- `posting_closed`). Like Paul's, it may close a pending or approved request at any time.
CREATE OR REPLACE FUNCTION approval_withdrawal_guard() RETURNS trigger
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
  -- Only an application can have a posting that closed.
  IF NEW.withdrawn_by = 'system' AND req.kind <> 'application_package' THEN
    RAISE EXCEPTION 'the system may only withdraw an application package request'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.withdrawn_at := northstar_gate_now();
  RETURN NEW;
END;
$$;

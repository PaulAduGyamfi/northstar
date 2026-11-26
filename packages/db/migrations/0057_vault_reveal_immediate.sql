-- NS-182 (ADR-0024): a vault_reveal decision takes effect at once. The undo window exists to cancel
-- something before it goes out; a reveal has nothing to cancel, and it must be usable within the
-- 60-second passkey check. Every other kind still waits 2 minutes. Otherwise migration 0037's guard.
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
  NEW.effective_at := CASE WHEN req.kind = 'vault_reveal' THEN NEW.decided_at
    ELSE NEW.decided_at + interval '2 minutes' END;
  RETURN NEW;
END;
$$;

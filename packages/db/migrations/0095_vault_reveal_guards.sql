-- NS-246 slice 2 (CRD-002, ADR-0024): two database guards around Paul's password reveal.
--
-- 1. A `vault_reveal` decision opens the vault only to reveal to Paul, and a reveal opens it only
--    under a `vault_reveal` decision. vault-write.ts already refuses both; this makes a writer that
--    skips it fail too. Decisions and requests are append-only, so the kind read here can't change.
CREATE FUNCTION vault_access_reveal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req_kind text;
BEGIN
  SELECT r.kind INTO req_kind
    FROM approval_decision d JOIN approval_request r ON r.id = d.request_id
    WHERE d.id = NEW.decision_id;
  IF req_kind = 'vault_reveal' AND NEW.purpose <> 'reveal_to_user' THEN
    RAISE EXCEPTION 'a reveal approval opens the vault only to reveal to Paul'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose = 'reveal_to_user' AND req_kind IS DISTINCT FROM 'vault_reveal' THEN
    RAISE EXCEPTION 'a reveal needs its own reveal approval'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vault_access_reveal_checks
  BEFORE INSERT ON vault_access
  FOR EACH ROW EXECUTE FUNCTION vault_access_reveal_guard();
--> statement-breakpoint
-- 2. A reveal is approved and used in one transaction and is never in the queue, so nobody
--    withdraws one. This replaces migration 0081's withdrawal guard with the same locks and checks,
--    plus that rule.
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
  IF req.kind = 'vault_reveal' THEN
    RAISE EXCEPTION 'a reveal approval is never withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
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

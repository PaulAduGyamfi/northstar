-- The Apply Gateway's database guards (NS-120, APPLY-008/009, .claude/rules/db.md).

-- A submission row changes once: from in_progress to submitted or needs_human, and only its
-- status, reason and finished_at. Nothing else is rewritten, and no row is deleted, so the
-- ledger that says "this requisition was applied to" can't be emptied by a later write.
CREATE FUNCTION apply_submission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'apply_submission: % is not allowed', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'in_progress' OR NEW.status = 'in_progress' THEN
    RAISE EXCEPTION 'apply_submission: only an in_progress row may finish, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.candidate_id <> OLD.candidate_id
     OR NEW.application_id <> OLD.application_id OR NEW.decision_id <> OLD.decision_id
     OR NEW.ats <> OLD.ats OR NEW.requisition_key <> OLD.requisition_key
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'apply_submission: only status, reason and finished_at may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER apply_submission_guard_row
  BEFORE UPDATE OR DELETE ON apply_submission
  FOR EACH ROW EXECUTE FUNCTION apply_submission_guard();
--> statement-breakpoint
CREATE TRIGGER apply_submission_no_truncate
  BEFORE TRUNCATE ON apply_submission
  FOR EACH STATEMENT EXECUTE FUNCTION apply_submission_guard();
--> statement-breakpoint
-- Proof of submission is written once and never changed or removed (APPLY-008).
CREATE TRIGGER submission_proof_no_update_or_delete
  BEFORE UPDATE OR DELETE ON submission_proof
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER submission_proof_no_truncate
  BEFORE TRUNCATE ON submission_proof
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();

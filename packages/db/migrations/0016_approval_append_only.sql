-- Approval records are immutable (APR-004, ADR-0017, .claude/rules/db.md): a request, a policy
-- set, a decision and an undo are each written once and never changed or removed. A decision is
-- taken back by appending an undo, never by editing the decision.
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
-- A request has at most one live decision (one with no undo). The request row is locked first, so
-- two decisions racing for the same request are serialized and the second one is refused.
CREATE FUNCTION approval_decision_one_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM approval_request WHERE id = NEW.request_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM approval_decision d
    WHERE d.request_id = NEW.request_id
      AND NOT EXISTS (SELECT 1 FROM approval_undo u WHERE u.decision_id = d.id)
  ) THEN
    RAISE EXCEPTION 'approval request already has a live decision'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_decision_one_live_per_request
  BEFORE INSERT ON approval_decision
  FOR EACH ROW EXECUTE FUNCTION approval_decision_one_live();
--> statement-breakpoint
-- An undo is only possible inside the decision's undo window.
CREATE FUNCTION approval_undo_in_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM approval_decision d
    WHERE d.id = NEW.decision_id AND NEW.undone_at < d.effective_at
  ) THEN
    RAISE EXCEPTION 'the undo window for this decision has closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_undo_within_window
  BEFORE INSERT ON approval_undo
  FOR EACH ROW EXECUTE FUNCTION approval_undo_in_window();

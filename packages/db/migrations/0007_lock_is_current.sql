-- is_current (0006) is a locked fact like the dates: "still there" or not is an employment fact.
-- Replaces the role guard from 0004 with the same checks plus is_current.
CREATE OR REPLACE FUNCTION role_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.locked OR locked_fact_unlocked() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.locked IS DISTINCT FROM OLD.locked
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.employer IS DISTINCT FROM OLD.employer
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.start_month IS DISTINCT FROM OLD.start_month
    OR NEW.end_month IS DISTINCT FROM OLD.end_month
    OR NEW.is_current IS DISTINCT FROM OLD.is_current THEN
    RAISE EXCEPTION 'role employer, title, dates and current are locked facts; only Paul can change them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

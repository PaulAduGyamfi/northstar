-- Locked facts (CPG-004, ADR-0004): employers, titles, dates, schools and degrees never change
-- through generation. A change needs a transaction that set northstar.locked_edit = 'user', which
-- only editLockedFact (Paul's own edit) does, scoped to that transaction.
-- One function per table: PL/pgSQL may evaluate every operand of an OR/AND, so a shared function
-- would read role columns on education rows. On DELETE, NEW is NULL and every NEW.x is NULL, so
-- each IS DISTINCT FROM test is true; that's harmless because TG_OP = 'DELETE' raises anyway.
CREATE FUNCTION locked_fact_unlocked() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('northstar.locked_edit', true), '') = 'user'
$$;
--> statement-breakpoint
CREATE FUNCTION role_locked_guard() RETURNS trigger
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
    OR NEW.end_month IS DISTINCT FROM OLD.end_month THEN
    RAISE EXCEPTION 'role employer, title and dates are locked facts; only Paul can change them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION education_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.locked OR locked_fact_unlocked() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.locked IS DISTINCT FROM OLD.locked
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.school IS DISTINCT FROM OLD.school
    OR NEW.degree IS DISTINCT FROM OLD.degree
    OR NEW.field IS DISTINCT FROM OLD.field
    OR NEW.start_month IS DISTINCT FROM OLD.start_month
    OR NEW.end_month IS DISTINCT FROM OLD.end_month THEN
    RAISE EXCEPTION 'education school, degree and dates are locked facts; only Paul can change them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER role_locked_facts
  BEFORE UPDATE OR DELETE ON role
  FOR EACH ROW EXECUTE FUNCTION role_locked_guard();
--> statement-breakpoint
CREATE TRIGGER education_locked_facts
  BEFORE UPDATE OR DELETE ON education
  FOR EACH ROW EXECUTE FUNCTION education_locked_guard();

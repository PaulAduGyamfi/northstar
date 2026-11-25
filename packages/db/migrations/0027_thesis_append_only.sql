-- The positioning thesis is append-only (NS-155, DX-009): each version Paul approved, and the
-- atoms it cites, are written once. A new thesis is a new version.
CREATE FUNCTION thesis_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER positioning_thesis_no_update_or_delete
  BEFORE UPDATE OR DELETE ON positioning_thesis
  FOR EACH ROW EXECUTE FUNCTION thesis_reject_change();
--> statement-breakpoint
CREATE TRIGGER positioning_thesis_no_truncate
  BEFORE TRUNCATE ON positioning_thesis
  FOR EACH STATEMENT EXECUTE FUNCTION thesis_reject_change();
--> statement-breakpoint
CREATE TRIGGER positioning_thesis_atom_no_update_or_delete
  BEFORE UPDATE OR DELETE ON positioning_thesis_atom
  FOR EACH ROW EXECUTE FUNCTION thesis_reject_change();
--> statement-breakpoint
CREATE TRIGGER positioning_thesis_atom_no_truncate
  BEFORE TRUNCATE ON positioning_thesis_atom
  FOR EACH STATEMENT EXECUTE FUNCTION thesis_reject_change();
--> statement-breakpoint
-- Every version cites at least one atom (ADR-0004). Checked at commit, so the thesis row and its
-- atom links can be written in either order inside one transaction.
CREATE FUNCTION thesis_cites_an_atom() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM positioning_thesis_atom WHERE thesis_id = NEW.id) THEN
    RAISE EXCEPTION 'a positioning thesis must cite at least one experience atom'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER positioning_thesis_has_atom
  AFTER INSERT ON positioning_thesis
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION thesis_cites_an_atom();

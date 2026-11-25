-- Approved stories are locked (ADR-0004, NS-111): Paul approved these words, so generators may
-- cite a story but never rewrite it, delete it or change which atoms it cites. A story is written
-- as a draft, its atom links added, then it is approved (saveApprovedStory); after that, no change.
CREATE FUNCTION story_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved story is locked; it can be cited, never changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER story_locked
  BEFORE UPDATE OR DELETE ON story
  FOR EACH ROW EXECUTE FUNCTION story_locked_guard();
--> statement-breakpoint
-- The atoms an approved story cites are part of it: no link added, changed or removed.
CREATE FUNCTION story_atom_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN target := NEW.story_id; ELSE target := OLD.story_id; END IF;
  IF EXISTS (SELECT 1 FROM story WHERE id = target AND status = 'approved')
    OR (TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1 FROM story WHERE id = NEW.story_id AND status = 'approved')) THEN
    RAISE EXCEPTION 'an approved story''s atoms are locked'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER story_atom_locked
  BEFORE INSERT OR UPDATE OR DELETE ON story_atom
  FOR EACH ROW EXECUTE FUNCTION story_atom_locked_guard();
--> statement-breakpoint
-- Every story cites at least one atom (ADR-0004). Checked at commit, so the story row and its
-- links can be written in either order inside one transaction.
CREATE FUNCTION story_cites_an_atom() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM story_atom WHERE story_id = NEW.id) THEN
    RAISE EXCEPTION 'a story must cite at least one experience atom'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER story_has_atom
  AFTER INSERT OR UPDATE ON story
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION story_cites_an_atom();

-- NS-212 (#194): the role the app connects as. It owns nothing, so it can never disable a trigger,
-- truncate or alter a table; on append-only tables it may only read and insert. Created without
-- LOGIN: Paul gives it a password and LOGIN once, outside the repo. Migrations keep running as the
-- owner (DATABASE_MIGRATION_URL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'northstar_app') THEN
    CREATE ROLE northstar_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO northstar_app;
--> statement-breakpoint
-- Grants every table in public by one rule, so a later migration that adds a table just calls it
-- again (SELECT northstar_grant_app_role();). A table is append-only when a trigger on UPDATE or
-- DELETE runs a *_reject_change function: then SELECT and INSERT only. Every other table also gets
-- UPDATE and DELETE (its own guards still apply: the role can't disable them). Never TRUNCATE,
-- REFERENCES, TRIGGER or ownership.
CREATE OR REPLACE FUNCTION northstar_grant_app_role() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  append_only boolean;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger tg
      JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE tg.tgrelid = t.oid
        AND NOT tg.tgisinternal
        -- Trigger type bits: 8 is DELETE, 16 is UPDATE.
        AND (tg.tgtype & (8 | 16)) <> 0
        AND p.proname LIKE '%\_reject\_change'
    ) INTO append_only;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM northstar_app', t.relname);
    IF append_only THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO northstar_app', t.relname);
    ELSE
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO northstar_app',
        t.relname
      );
    END IF;
  END LOOP;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO northstar_app;
END
$$;
--> statement-breakpoint
-- Only migrations (the owner) run it.
REVOKE EXECUTE ON FUNCTION northstar_grant_app_role() FROM PUBLIC;
--> statement-breakpoint
SELECT northstar_grant_app_role();

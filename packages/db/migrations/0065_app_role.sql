-- NS-212 (#194): the role the app connects as. It owns nothing, so it can never disable a trigger,
-- truncate or alter a table; on append-only tables it may only read, insert and lock rows. Created
-- without LOGIN: Paul gives it a password and LOGIN once, outside the repo. Migrations keep running
-- as the owner (DATABASE_MIGRATION_URL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'northstar_app') THEN
    CREATE ROLE northstar_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Whoever made it, it holds no other power (a role Paul created by hand included).
ALTER ROLE northstar_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
--> statement-breakpoint
-- No temporary tables: the guard triggers name their tables without a schema, and a session's
-- temporary table of the same name is searched first, so it could answer a guard's lookup.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM northstar_app', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO northstar_app;
--> statement-breakpoint
-- Grants every table in public by one rule, so a later migration that adds a table or an
-- append-only trigger just calls it again (SELECT northstar_grant_app_role();).
-- A table is append-only when a trigger on UPDATE or DELETE runs a *_reject_change function: then
-- SELECT and INSERT. Postgres also needs UPDATE on one column for SELECT … FOR UPDATE (the Gate,
-- the vault and others lock rows), so a table whose updates such a trigger refuses also gets
-- UPDATE on its first column: the trigger refuses any real update, and the role can't disable it.
-- Every other table gets SELECT, INSERT, UPDATE and DELETE (its own guards still apply). Never
-- TRUNCATE, REFERENCES, TRIGGER or ownership.
CREATE OR REPLACE FUNCTION northstar_grant_app_role() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  append_only boolean;
  update_refused boolean;
  first_column text;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    -- Trigger type bits: 8 is DELETE, 16 is UPDATE.
    SELECT
      coalesce(bool_or((tg.tgtype & (8 | 16)) <> 0), false),
      coalesce(bool_or((tg.tgtype & 16) <> 0), false)
    INTO append_only, update_refused
    FROM pg_trigger tg
    JOIN pg_proc p ON p.oid = tg.tgfoid
    WHERE tg.tgrelid = t.oid
      AND NOT tg.tgisinternal
      AND p.proname LIKE '%\_reject\_change';
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM northstar_app', t.relname);
    IF append_only THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO northstar_app', t.relname);
      IF update_refused THEN
        SELECT a.attname INTO first_column
        FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
        LIMIT 1;
        EXECUTE format(
          'GRANT UPDATE (%I) ON TABLE public.%I TO northstar_app',
          first_column,
          t.relname
        );
      END IF;
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

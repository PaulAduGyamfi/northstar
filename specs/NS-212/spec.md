# NS-212: Run the app as a database role that can't disable the append-only triggers

Status: draft
Requirements: APR-004 (approval records immutable), NFR-SEC (least privilege), ADR-0012
(append-only event log), ADR-0017 (Gate records)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`. Decision on #194
(Paul's delegation, 2026-11-26): role `northstar_app`, created by a migration as `NOLOGIN`;
`DATABASE_URL` becomes the app's URL and migrations use a new `DATABASE_MIGRATION_URL`; the
compose stack doesn't create the role; Paul sets its password and login once.
Parent: #69 (item 3)

## Why
Every append-only table (`domain_event`, `approval_*`, the vault, the answer bank, …) is guarded by
a trigger, but the app connects as the tables' owner, and an owner can
`ALTER TABLE … DISABLE TRIGGER` or `TRUNCATE`. A bug or a compromised process could then rewrite
history. The app should connect as a role that owns nothing, so the triggers always hold, and
that can't even ask to update or delete the append-only rows.

## Behavior
- Migration `0065` (custom SQL):
  - creates `northstar_app` as `NOLOGIN` if it doesn't exist;
  - grants `USAGE` on schema `public` and `USAGE, SELECT` on its sequences;
  - defines `northstar_grant_app_role()`, which grants on every table in `public`:
    - `SELECT, INSERT` on an append-only table: one with a trigger on UPDATE or DELETE that runs
      a `*_reject_change` function;
    - `SELECT, INSERT, UPDATE, DELETE` on every other table;
    - never `TRUNCATE`, `REFERENCES`, `TRIGGER` or ownership;
  - runs it once, and revokes its `EXECUTE` from `PUBLIC`.
- A later migration that adds a table calls `SELECT northstar_grant_app_role();` (db.md says so),
  and a test fails if any table's grants don't match the rule.
- `loadMigrationConfig(env)` in `packages/db/src/config.ts` reads `DATABASE_MIGRATION_URL`
  (required, named in the error, never its value). `db:migrate` (`src/migrate.ts`) uses it; every
  other entry point keeps `loadDbConfig` and `DATABASE_URL`.
- `.env.example`: `DATABASE_URL` connects as `northstar_app`, and `DATABASE_MIGRATION_URL` as the
  owner, both with `change-me` placeholders.

## Paul's one-time step (printed in the PR)
1. Put the current owner URL in `.env` as `DATABASE_MIGRATION_URL`.
2. `pnpm --filter @northstar/db db:migrate` (creates the role).
3. In psql as the owner: `ALTER ROLE northstar_app LOGIN PASSWORD '…';`
4. Change `DATABASE_URL` in `.env` to connect as `northstar_app` with that password.

## Acceptance criteria
- [ ] Every table in `public` grants `northstar_app` exactly what the rule says (PGlite test over
      `information_schema.role_table_grants` and the triggers).
- [ ] As `northstar_app` (`SET ROLE`): an insert into `domain_event` works; an update or delete
      of it is refused (insufficient privilege); `ALTER TABLE domain_event DISABLE TRIGGER ALL`
      and `TRUNCATE` are refused; an application's status moves through `transitionApplication`.
- [ ] `loadMigrationConfig` reads `DATABASE_MIGRATION_URL`, and its error names the setting only.
- [ ] `drizzle-kit generate` prints "No schema changes".
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- `.env` without `DATABASE_MIGRATION_URL`: `db:migrate` stops before connecting, naming it.
- The role exists already (a rerun, or Paul created it): the migration keeps it and only grants.
- A new table without a grant: the app gets "permission denied" on it, and the grant test fails in
  CI first.

## Observability
None new: permission errors surface as the queries' own errors in the existing spans.

## Out of scope
- Setting the password or LOGIN (Paul), and any change to the compose stack.
- Running the whole test suite as `northstar_app` (existing tests assert the triggers' own
  refusals, which the role's missing privileges would answer first).

## Open questions
- None.

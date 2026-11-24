# ADR-0012 — Append-only domain event log, and PGlite for database tests

**Status:** Proposed · **Date:** 2026-11-24

## Context
Every agent and worker action must emit a domain event (OBS-001), and every application status
change must emit one (requirement 03). The feed (OBS-002), the run inspector (OBS-003) and
analytics will read these events. They are only trustworthy if a status change and its event can
never disagree, and if nobody can rewrite history later. Retries must not double-write (RES-006).

The database rules (`.claude/rules/db.md`) say the database guards the data, so the schema needs
real Postgres tests. The sandbox gives each command a private network, and CI does not run the
NS-104 stack, so tests cannot reach a Postgres server. AGENTS.md forbids network in tests.

## Decision
1. **One event table, append-only.** `packages/db` has a `domain_event` table. A trigger rejects
   every `UPDATE`, `DELETE` and `TRUNCATE` on it. Each row has an identity `position`.
2. **Same transaction as the change.** `transitionApplication()` updates `application.status`
   and inserts the event in one transaction (the outbox pattern). The update is conditional on
   the expected current status, so two racing writers cannot both win.
3. **Idempotency in the schema.** `UNIQUE (candidate_id, idempotency_key)` on `domain_event`. A
   repeat call returns the stored event and changes nothing.
4. **Readers keep their own cursor.** Consumers read with `readEventsAfter(position)` and store
   the last position they handled. Events never carry a "published" flag. The cursor table
   arrives with the first reader (NS-125).
5. **Event names** are `application.<to-status>` for status changes. Other aggregates use
   `<aggregate>.<past-tense-verb>` (`job.ingested`).
6. **Database tests run on PGlite** (`@electric-sql/pglite`, dev dependency only), in-process,
   with pgvector from `@electric-sql/pglite-pgvector` (PGlite 0.5 ships it separately). Each test file applies every committed migration to a fresh
   in-memory database. Production and local dev stay on Postgres 16 via `pg` and Drizzle
   (ADR-0005).

## Alternatives considered
- **A `published_at` column updated by a relay:** breaks append-only, and one flag cannot serve
  several readers.
- **Publish events straight to a bus (or Temporal) after commit:** a crash between commit and
  publish loses the event.
- **Postgres service in CI, tests skipped in the sandbox:** tests would behave differently on
  Paul's machine, in the agent sandbox and in CI. A skipped test proves nothing.
- **Testcontainers:** needs Docker and network from the test process, which the sandbox blocks.
- **Mocking the database:** cannot prove CHECK, UNIQUE or trigger behavior, which is the point.

## Consequences
- + Through `transitionApplication`, a status change always has its event, and a retry never
  writes a second one (UNIQUE on the idempotency key). A raw `UPDATE application SET status`
  would still skip the event: only `.claude/rules/db.md` stops it today.
- + Database tests run the same everywhere, need no secrets, and stay fast.
- − PGlite tracks Postgres 17, production is 16. A 17-only feature could pass tests. Running
  `db:migrate` on the NS-104 stack before merge catches migration-level differences; we must keep
  doing that for every migration.
- − Fixing a wrong event means appending a correcting event, never editing one.
- − `position` comes from a sequence, so with concurrent writers a lower position can commit after
  a higher one. A reader that jumps its cursor past an uncommitted gap would skip that event. The
  first reader (NS-125) must handle this, for example by reading only up to the oldest open
  transaction or by re-reading a short window behind its cursor.
- − The trigger stops bugs, not an attacker. The app connects as the table owner (the image's
  superuser), which can disable triggers. A separate app role that owns nothing is a later ticket.
- − The event table grows forever. Archiving or partitioning is a later decision.
- Open question: whether PGlite stays close enough to Postgres 16 once we use pgvector indexes.

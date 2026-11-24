# NS-105: Domain + db packages: entities, state machine, event outbox, migrations

Status: approved by Paul (2026-11-24; PGlite, inferred moves, `application.<to>`, one PR, esbuild allowed)
Requirements: 03 "Statuses (application state machine)", OBS-001 (every action emits a domain
event), RES-006 (safe to repeat), RES-011 (expand, migrate, contract), Q-02 (`candidate_id` on
every row). ADR-0005 (Postgres 16 + pgvector, Drizzle), ADR-0007 (deterministic core),
ADR-0008 (OpenTelemetry). GitHub issue #6.
Rules that apply: AGENTS.md (code style, dependencies, "don't create folders early"),
`.claude/rules/db.md`, `.claude/rules/tests.md`, ADR-0012 (append-only event log, PGlite tests).

## Why
Every feature ticket after this one moves a job through the application pipeline and has to say
what it did. Today nothing defines the pipeline's states, which moves between them are legal, or
where "what happened" is written down. After this ticket there is one state machine in plain
code, one database schema that refuses bad data, and one append-only event log that every status
change writes to in the same transaction. The activity feed (NS-125) and the run inspector read
that log later. If it isn't in the log, it didn't happen.

## Behavior
**`packages/domain`** (pure TypeScript, no I/O):
- `APPLICATION_STATUSES`: the 14 statuses from requirement 03, in order: `discovered`, `scored`,
  `queued`, `package_ready`, `awaiting_approval`, `submitting`, `needs_human`, `submitted`,
  `confirmed`, `in_process`, `offer`, `rejected`, `withdrawn`, `ghosted`.
- A transition table that says which status may follow which (open question 2), and
  `nextStatus(from, to)` that returns the new status or a typed `IllegalTransition` error. No
  exceptions for expected outcomes; no LLM anywhere (ADR-0007).
- `DomainEvent`: one Zod schema for every event. Fields: `id`, `candidateId`, `aggregate`
  (`application:<id>`), `type` (`application.submitted`, ...), `actor` (`agent:<name>`,
  `user`, `system`), `reason`, `payload` (from, to and inputs summary), `links`, `traceId`,
  `idempotencyKey`, `occurredAt`. The OBS-001 fields (actor, inputs summary, outputs, reason,
  links) are all required or explicitly empty.
- Branded ID types (`CandidateId`, `ApplicationId`, ...) so one kind of ID can't be passed as
  another.

**`packages/db`** (Drizzle schema + migrations + one write path):
- Tables: `candidate`, `company`, `job`, `application`, `domain_event`. Only what the state
  machine and the outbox need; every other entity in system-design §4 arrives with its ticket.
- Every row has `candidate_id` with a foreign key (Q-02). The database itself guards the data:
  `NOT NULL`, a `CHECK` that `application.status` is one of the 14 statuses, one application per
  job per candidate (`UNIQUE (candidate_id, job_id)`, APPLY-009's base), and
  `UNIQUE (candidate_id, idempotency_key)` on `domain_event`.
- `domain_event` is append-only: a trigger rejects every `UPDATE` and `DELETE`. Events carry a
  monotonically increasing `position`, so readers (the feed, later) keep their own cursor and
  the log never changes.
- The first migration runs `CREATE EXTENSION IF NOT EXISTS vector` (NS-104's note). No vector
  columns yet.
- `transitionApplication(db, input)`: in one transaction, checks the move with `nextStatus`,
  updates the application only if its status is still `from` (so two racing workers can't both
  win), and appends the event. Called twice with the same idempotency key, it returns the first
  event and changes nothing. It opens an OpenTelemetry span and stores that span's trace ID on
  the event.
- `readEventsAfter(db, candidateId, position, limit)`: events in order, for a future reader.
- `pnpm --filter @northstar/db db:generate` makes a migration from the schema (no database
  needed). `pnpm --filter @northstar/db db:migrate` applies migrations to the database in
  `DATABASE_URL`, read once through a typed, Zod-checked config function.
- Tests run every migration against an in-process Postgres (PGlite with pgvector), so they need
  no network, no Docker and no secrets, in the sandbox and in CI (open question 1).

## Acceptance criteria
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, with tests in both packages.
- [ ] Domain tests prove: every allowed move succeeds, every other pair returns `IllegalTransition`
      (the full 14×14 table is checked), terminal statuses have no exits, and a malformed event
      fails the Zod schema.
- [ ] DB tests (PGlite, every migration applied) prove:
  - a status outside the 14 is rejected by the database, not only by TypeScript;
  - a second application for the same job and candidate is rejected;
  - `UPDATE` and `DELETE` on `domain_event` are rejected;
  - a transition changes the status and writes exactly one event, in one transaction;
  - an illegal transition writes nothing and returns `IllegalTransition`;
  - running the same transition twice leaves one status change and one event;
  - two transitions from the same stale `from` status: one wins, the other gets `StaleStatus`;
  - the event's `traceId` equals the span the transition opened;
  - `readEventsAfter` returns events in `position` order after the cursor.
- [ ] `pnpm --filter @northstar/db db:generate` reports no schema changes (migrations match the
      schema).
- [ ] Paul, outside the sandbox, with the NS-104 stack up: `pnpm --filter @northstar/db db:migrate`
      exits 0, then `psql` `\dt` lists the five tables and `\dx` lists `vector`.
- [ ] `.env.example` has `DATABASE_URL` with a `change-me` placeholder.
- [ ] AGENTS.md lists the two db commands and no longer calls `packages/domain` an empty shell.
- [ ] `checks` is green on the PR.

## Failure modes
- **Postgres down or unreachable (`db:migrate`):** the command fails with the connection error
  and exits non-zero; nothing is half-applied because each migration runs in a transaction.
  App callers of `transitionApplication` get the driver error, not a silent drop; retries are
  safe because of the idempotency key.
- **A migration fails partway:** its transaction rolls back and the migrations table doesn't
  record it. Fix by adding a new migration, never by editing an applied one.
- **Two workers move the same application:** the conditional update lets one win; the other gets
  `StaleStatus` and no event. The caller decides to re-read or give up.
- **A retry after a crash:** the idempotency key returns the original event. No double event, no
  double status change (RES-006).
- **Bad event payload (a bug in a caller):** Zod rejects it before the transaction starts, so no
  partial write.
- **`DATABASE_URL` missing or malformed:** the config function fails at startup and names the
  setting, never its value.
- **OpenTelemetry not configured:** `@opentelemetry/api` is a no-op; the transition still works and
  the event's `traceId` is null.

## Observability
- Each status change appends one `domain_event` row (`application.<to>`, e.g.
  `application.submitted`), with actor, reason, from/to, links and trace ID (OBS-001).
- `transitionApplication` opens the span `db.application.transition` with attributes
  `northstar.application.id`, `northstar.status.from`, `northstar.status.to` and
  `northstar.idempotent_replay`; illegal or stale moves set the span status to error with the
  error kind. No secrets, resume text or email bodies in events or spans.
- Exporting spans to the LGTM stack is the app's job (NS-106 and the worker tickets); this ticket
  only uses the API.

## Out of scope
- Every other entity in system-design §4 (atoms, stories, packages, approvals, emails, ...): each
  arrives with its ticket. `approval` arrives with NS-119.
- The outbox relay and per-reader cursors, the feed, SSE (NS-125).
- `in_process` sub-stages (screen, onsite, ...), embeddings and vector columns.
- Temporal workflows and workers, the OpenTelemetry SDK setup and exporters.
- A shared config package. The typed config function lives in `packages/db` until a ticket
  needs settings elsewhere.

## Open questions
1. **Database for tests (new dev dependency, needs an ADR).** Tests can't reach a network
   Postgres in the sandbox, and CI doesn't run the stack. Recommended: PGlite
   (`@electric-sql/pglite`, real Postgres compiled to WASM, ships pgvector) in-process. Cost: it
   tracks Postgres 17 while production is 16, so a 17-only feature could pass tests; the
   `db:migrate` run on the real stack catches that. Alternative: a CI Postgres service plus
   tests that skip in the sandbox, which breaks "tests run the same everywhere".
2. **The transition table is inferred**, beyond the order requirement 03 lists. Proposed extra
   moves: `awaiting_approval → queued` (approval rejected, re-tailor); `submitting → needs_human`
   and `needs_human → submitting | submitted` (APPLY-006 handoff and resume); `submitted →
   in_process | rejected | ghosted` (confirmation email may never come); `confirmed → in_process |
   rejected | ghosted`; `in_process → offer | rejected | ghosted`; `ghosted → in_process |
   rejected` (a late reply revives it); any status except `rejected`, `withdrawn` and `ghosted`
   `→ withdrawn`. Terminal: `rejected`, `withdrawn`. `offer` only exits to `withdrawn`.
3. **Event names.** Proposed: one type per target status (`application.<to>`). OBS-001's
   example `package.ready` would then be `application.package_ready`; `job.skipped` and
   `job.ingested` are job events and arrive with sourcing (NS-114/115).
4. **Diff size.** About 350 lines of source plus about 300 of tests, over AGENTS.md's ~300. The
   tasks commit in small green steps; splitting `packages/db` into its own ticket is the
   alternative.
5. **`drizzle-kit` pulls in `esbuild`, which has an install script.** `strictDepBuilds` will fail
   the install until `esbuild` is in `onlyBuiltDependencies` (Paul's approval). Otherwise we
   write migrations by hand and drop `drizzle-kit`.

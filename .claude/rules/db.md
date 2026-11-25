---
paths:
  - "packages/db/**"
---

# Database schema and migrations (Postgres 16 + pgvector, Drizzle)

Lives in `packages/db` since NS-105. The event log design and PGlite tests are ADR-0012. The
profile graph (NS-110) is in `src/profile-schema.ts`, the story bank (NS-111) in
`src/story-schema.ts`.

- Locked facts (CPG-004): `role` employer/title/dates/is_current and `education` school/degree/field/dates
  are guarded by a trigger. Change them only through `editLockedFact` (Paul's own edits); never
  set `northstar.locked_edit` anywhere else.
- Approved stories (NS-111) are locked by a trigger: no update or delete, and no change to their
  `story_atom` links. Write the story bank only through `story-write.ts`. `story_answer` holds
  Paul's own words: never copy them into events, spans, logs or fixtures.
- The official employment record (NS-112, DX-011) is `employment_fact`, written only through
  `facts-write.ts`. A new record supersedes the old rows; nothing is deleted. Its events carry
  counts only, never employers, titles or dates.
- The funnel backfill (NS-113) stores `funnel_message` (Gmail ids, dates and extracted fields;
  never a subject, body or address) and `funnel_manual_row` (Paul's tracker export, replaced per
  import), through `funnel-write.ts` only. Funnel records are derived in `packages/funnel`, never
  stored. Funnel events carry counts and fixed names only.

- Migrations are generated (`db:generate`; `--custom` for SQL Drizzle can't express, such as
  extensions and triggers), reviewed and committed. Never edit an applied migration; add a new one.
- Backward-compatible changes: expand, migrate, contract (RES-011).
- The database guards the data: NOT NULL, CHECK, foreign keys and unique constraints
  (requisition dedupe, idempotency keys) in the schema, not only in TypeScript.
- Every row belongs to a `candidate_id` (Q-02: single tenant now, no shortcuts).
- Approval records and events are append-only.
- Queries use parameters, never string-built SQL.
- Tests only touch databases whose name ends in `_test`. Unit tests use `createTestDb()` (in-process
  PGlite with every migration applied), never a server.
- Application status changes go through `transitionApplication` only, so each one writes its event.
- Jobs (NS-114) are written through `job-write.ts` only: `saveIngestedJob` (create, merge as a new
  `job_source`, or unchanged) and `setJobField` (Paul's edits). A job missing a title or company is
  a `draft`; a check refuses a `ready` one without them. Job events carry ids, counts and methods,
  never a title, company or URL.
- The watchlist (NS-115, ADR-0015) is `company_watch`, written only through `watch-write.ts`. It
  holds the scheduling state (`next_poll_at`, failures, status); `packages/sources` decides
  backoff and quarantine. Its events carry the ATS kind, tier and counts, never a board name.
- Search preferences and fit scores (NS-116) are `search_preference` (one row per version; the
  current one is the highest version) and `fit_score` (unique per job, preference version, resume
  import and job fingerprint), written only through `fit-write.ts` (`fit-schema.ts`), which only
  inserts: rows are never edited, by that convention (no trigger guards them). `packages/sources`
  decides the score. Their events (`preferences.changed`, `preferences.rescored`, `job.scored`)
  carry ids, versions, numbers, bands, reason codes, flags and field names, never a preference
  value, title, requirement or atom text.
- The Approval Gate's records (NS-119, ADR-0017) are `approval_request`, `approval_policy_set`,
  `approval_decision` and `approval_undo`: append-only (triggers), written only through
  `approval-write.ts`. Reject reasons and draft text never go into events or spans. Every Gate
  time comes from `northstar_gate_now()`, and Gate functions take no time from their caller; never
  override it outside the PGlite test setup (`src/test/global-setup.ts`). Gate transactions stay
  READ COMMITTED.
- The answer bank (GH-59) is `bank_answer`, `bank_answer_citation` and `bank_answer_use`:
  append-only (a trigger refuses UPDATE, DELETE and TRUNCATE), written only through
  `answer-write.ts`. An answer is stored only with a live Gate approval by Paul (kind `answer`,
  subject `answer:<id>`, `answerContentSha256`). The answer text is Paul's words: never copy it
  into events, spans, logs or fixtures.
- Resilience state (NS-126, ADR-0007) is `dependency_breaker` (one row per dependency, written
  only through `breaker-write.ts`) and `kill_switch` (append-only, written only through
  `kill-switch-write.ts`; the newest row per subsystem is its state, no row means on). Breaker
  events are written only on a change of state and carry the dependency, counts and an error name,
  never a message or URL.
- One agent at a time changes this package's schema or migrations (ADR-0016): parallel agents
  renumbering migrations caused replacement PRs. Before adding a migration, merge the latest
  `main` and generate it then.

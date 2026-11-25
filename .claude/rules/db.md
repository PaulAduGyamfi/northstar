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

# NS-247 slice 2: a stored cursor for the mail poll

Status: done, in review (autonomous lane, ADR-0016)
Issue: #293 (item 1's stored cursor; parent #224)
Requirements: INB-002, INB-009; RES-006 (safe to repeat)
Rules that apply: ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
`pollNewMail` keeps its cursor (`nextSince`, `nextOverlap`) in memory, so a restart starts over
from whatever the caller passes. The worker process (#230) needs a cursor that survives restarts:
a crash must neither skip mail nor read everything again.

## Behavior
- **Storage** (`packages/db`, migration 0097, `mail-poll-schema.ts`): append-only
  `mail_poll_cursor`, one row per move: candidate, `since` and `overlap`. The newest row is
  current. UPDATE, DELETE and TRUNCATE are refused by the shared trigger.
- **Read and write** (`mail-poll-write.ts`): `readMailCursor(db, candidateId)` gives the newest
  `{ since, overlap }` or null. `saveMailCursor(db, { candidateId, since, overlap })` stores a new
  row only when the cursor changes. It never moves `since` backwards: an older `since` keeps the
  stored one (a slow run finishing after a newer one can't rewind it). It writes no domain event,
  since it moves on every tick with mail and the feed would fill with bookkeeping, but it records a
  `mail.cursor_save` span.
- **The poll with its cursor** (`packages/inbox`, `link/cursor.ts`): `pollFromCursor(deps, opts)`
  reads the cursor through a port, runs `pollNewMail` from it (`firstSince` on the very first run),
  then saves the report's `nextSince` and `nextOverlap`. A run that stopped at a message still
  saves its cursor, which is the last message handled before the stop, so nothing after it is
  skipped. A failed save is thrown, and the next tick re-reads the old cursor; the step records
  nothing twice.
- **A future cursor fails loudly:** `saveMailCursor` refuses a `since` more than 5 minutes
  after now, and `pollFromCursor` throws `FutureCursorError` before asking Gmail when its cursor
  or `firstSince` is in the future. Since the cursor never moves backwards, a stored future cursor
  would otherwise stop all linking silently (security review).
- **For #230:** call `pollFromCursor` once per tick, with `cursor: { read: () =>
  readMailCursor(db, id), save: (c) => saveMailCursor(db, { candidateId: id, ...c }) }` and the
  step's ports.

## Acceptance criteria
- [x] Read, save, no-op save, never-backwards and the append-only guard (PGlite).
- [x] `pollFromCursor`: first run from `firstSince`, later runs from the stored cursor, saves the
      report's cursor, and saves even when stopped at a message (fakes).
- [ ] lint, typecheck, test, build green (CI `checks`: this container's Node 22 can't install the
      workspace).

## Out of scope
- The scheduled caller and dead-lettering stuck messages (#230).

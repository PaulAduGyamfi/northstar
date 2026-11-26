# NS-188: Application origin, credit report, tagged address on forms and the mail-link loop

Status: accepted (autonomous lane, ADR-0016), in slices
Requirements: INB-007, INB-009, INB-010, VER-007 · ADR-0012
Rules that apply: `.claude/rules/db.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`
Parent: #109 (NS-158)

## Why
INB-007: every application records who started it and how it went out, so INB-010's credit
report can say how much of the pipeline Northstar earned. The rest of the issue (the tagged
address on forms, the mail-link loop, `Delivered-To`) builds on NS-158's matcher.

## Slices
1. **Origin and the credit report (this PR).**
2. **`Delivered-To` and the mail-link loop.**
3. **The tagged address on forms:** waits for package assembly (NS-161, #112), which decides
   what the form gets.

## Slice 1
INB-007 says each origin value is a domain event and the latest one wins, so origin is stored as
events: no new table or column.
1. **Values** (`packages/domain`, `origin.ts`): `STARTED_BY` (`northstar`, `outside`,
   `recruiter_inbound`) and `SUBMITTED_VIA` (`auto`, `approved`, `handoff`, `by_hand`).
2. **`started_by`** (`packages/db`, `origin-write.ts`): `createApplication` inserts the
   application, its first event (`application.created`) and `application.started_by` in one
   transaction, keyed by the caller's idempotency key. Nothing calls it yet (package assembly
   will).
3. **`submitted_via`**: `transitionApplication` takes `submittedVia`, required for a move to
   `submitted` (refused as `MissingSubmittedVia` without it), and writes
   `application.submitted_via` in the same transaction as the move. A replayed move writes
   nothing new. Callers:
   - the Apply Gateway: `auto` when the Gate's decision was the policy's, `approved` when Paul's
     (`verifyApproval`'s `decidedBy`);
   - the API's "I submitted it" on a handoff: `handoff`.
4. **`readOrigin`**: the latest `started_by` and `submitted_via` of an application (null when
   none). Email matching writes neither: only these write paths do.
5. **Credit report** (`readCreditReport`, INB-010): per origin bucket, how many applications
   reached `submitted`, `in_process` and `offer`. Buckets: `northstar` (started by Northstar,
   not `by_hand`), `northstar_by_hand`, `outside`, `recruiter_inbound`, `unknown` (no origin).
   The replied, screen and interview stages INB-010 names come from inbox classification
   (NS-164, #115), which doesn't exist yet: those columns arrive with it.

### Acceptance criteria (slice 1)
- [ ] `createApplication` writes the application, `application.created` and `started_by` in one
      transaction; repeating it with the same key creates nothing new.
- [ ] A move to `submitted` without `submittedVia` is refused; with it, the move and
      `application.submitted_via` are written together; a replay writes neither again.
- [ ] Recording a mail link changes neither origin value (test).
- [ ] The credit report counts each stage reached per bucket.

## Out of scope
Slices 2 and 3. Origin badges in the app (INB-008). Correcting an origin by hand.

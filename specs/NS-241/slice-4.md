# NS-241 slice 4: prep plans through the Gate, the write ledger and the writer

Status: in progress
Requirements: CAL-001 (a dedicated Northstar calendar), CAL-003 (prep blocks, one approval per
interview), RES-006 (safe to repeat), OBS-001 (in the feed)
Rules that apply: ADR-0031 (Accepted) items 3–8, ADR-0002, ADR-0014, ADR-0026, ADR-0007,
ADR-0012, `.claude/rules/gateways.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
Slice 1 stores proposed prep blocks. Slice 3 built the Calendar writer's token, consent flow and
requests. This slice joins them through the Approval Gate: a stored proposal becomes one
`prep_plan` request, and the writer puts an approved plan on the Northstar calendar exactly once.

## Behavior
`packages/domain` (`prep-plan.ts`, plain code):
- `PREP_BLOCK_TITLES`: the fixed event titles ("Interview prep", "Interview warm-up"). The
  gateway's requests use the same constant, so the hash covers what is sent.
- `prepPlanSubject(proposalId)`: `prep_plan:<proposalId>`.
- `prepPlanContentSha256(plan)`: SHA-256 over the proposal id, the detection id and version, the
  calendar name "Northstar", and each block's kind, start, end and fixed title, in start order.
- `prepEventId(decisionId, index)`: the decision UUID's hex digits followed by the index, which is
  lowercase base32hex, as `events.insert` accepts.

`packages/db`, migration 0104 (append-only, `approval_reject_change` triggers, the app role):
- `prep_plan_request`: one row per `prep_plan` Gate request. A composite foreign key names the
  request's id, candidate, kind and content hash, and a CHECK pins the kind to `prep_plan`. One
  row per proposal. It stores the proposal id, detection id and detection version it was filed
  for.
- `prep_write_claim`: one row per attempt per decision, with a 5-minute lease.
- `prep_write_record`: one row per decision, holding the proposal id and block count.
- `northstar_calendar`: one row per candidate, holding the calendar id.

`prep-plan-write.ts`:
- `requestPrepPlanApproval(db, { candidateId, proposalId })` files the request from the stored
  proposal only, in one transaction with the row. It refuses an unknown proposal, a detection a
  reschedule replaced, an unconfirmed one, or an empty plan. A replay stores nothing.
- `readPrepPlan(db, candidateId, requestId)` gives the stored row, the proposal's blocks, the
  detection the request was filed for and the current detection for the same event and
  application.

`prep-ledger-write.ts`:
- `claimPrepWrite`, under a per-candidate advisory lock. There is one prep write at a time per
  candidate, so two runs can't each create a calendar. It answers:
  - `done` when the decision is already recorded;
  - `in_progress` with `retryAt` while any claim of the candidate's is in its lease and not
    recorded;
  - `unknown` for this decision after a lapsed lease, with a fresh claim;
  - otherwise `new`.
- `recordPrepWrite`, once per decision, with a `calendar.prep_written` event. It carries ids and
  the block count, and its feed line is a fixed-word `reason`. A different second record is
  refused.
- `readNorthstarCalendar` and `saveNorthstarCalendar`. Saving the same id again stores nothing; a
  different second id is refused.
- `dbCalendarLedger(db)` binds them to the writer's ports.

`calendar.prep_write` joins `DEAD_LETTER_KINDS`, with its words in `apps/web/src/dead-letters.ts`.

`packages/gateways/src/calendar/gateway.ts`, `writePrepPlan(ports, access, input)`, in order:
1. Read the stored plan and recompute its hash over the detection it was filed for. A mismatch
   is `ContentMismatch`.
2. `verifyApproval('prep_plan', subject, hash)`. `UndoWindowOpen` becomes `NotApproved` with
   `retryAt`, and the decision must belong to that request.
3. Recompute the hash over the current detection. If a reschedule changed it, the writer withdraws
   the approval (`withdrawApproval` by `gateway`, the new hash), answers `Rescheduled`, and writes
   nothing.
4. No `calendar.app.created` scope gives `needs_human` (`scope_missing`).
5. Claim the decision.
6. Find or create the calendar: the stored row, then the marker lookup, then `createCalendar`.
   The id is saved as soon as Google answers.
7. Insert each block with its `prepEventId`. A 409 counts as already written.
8. Record the write.

Held-back requests (kill switch, breaker) are the `HeldBack` refusal.

## Acceptance criteria
- [ ] The hash changes with any block, the detection version or the proposal; event ids are valid
      base32hex and differ per index.
- [ ] `requestPrepPlanApproval` files once, a replay stores nothing, and it refuses superseded,
      unconfirmed, unknown and empty plans.
- [ ] The foreign key refuses a row whose request has another kind or hash.
- [ ] Claims: `new`, then `in_progress` for this decision and for another decision of the same
      candidate, then `unknown` after the lease, then `done` after recording. A different second
      record or calendar id is refused.
- [ ] The tables are append-only, and `app-role.test.ts` passes.
- [ ] The writer refuses an unapproved plan, waits out the undo window with `retryAt`, withdraws
      on a reschedule, gives `scope_missing`, writes each block once across a retry (409), reuses
      the stored calendar, finds the marked one after an unknown outcome, and records the write.
- [ ] `pnpm --filter @northstar/domain --filter @northstar/db --filter @northstar/gateways
      --filter @northstar/web lint typecheck test` pass.

## Out of scope
The command Paul runs: per-run consent, filing requests for stored proposals and writing approved
ones (the next slice). Also out: proposal rounds after a rejection, reminders (CAL-004) and
reading the Northstar calendar's busy time.

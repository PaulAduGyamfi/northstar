# NS-226: The submission workflow ends visibly (slice 1)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RES-001, RES-005, RES-007, OBS-001 · ADR-0001, ADR-0007.
GitHub issue #231 (Parent: #108).
Rules that apply: `.claude/rules/worker.md`, `.claude/rules/tests.md`.

## Why
`submissionWorkflow` (`apps/worker`) can end in ways only Temporal's history shows:
- `refused`: the gateway refused for good;
- `gave_up`: still held back after `MAX_WAITS`;
- `not_approved`: the Gate refused the decision at send time;
- the activity failing all 5 of its attempts.

None of these leaves a `needs_human` item, a dead letter or a feed line, so the application sits
waiting with a live approval and nobody sees it. Nothing runs the workflow yet (#230), so this has
to land before a worker does.

## Behavior
1. **`SubmissionInput` gains `applicationId`.** The dead letter needs its subject and key. The
   package still travels in the input; item 2 of #231 moves it out (see Out of scope).
2. **A plain-code `endingLetter(result | failure)`** (`src/workflows/ending.ts`) maps each ending
   to a dead letter's reason code, or `null` when the ending is already visible:
   - `submitted`, `needs_human` and `withdrawn` → `null`. The gateway's proof, its handoff and the
     Gate's `approval.withdrawn` already show these.
   - `refused` → `refused_<refusal in snake case>`, e.g. `refused_duplicate_requisition`.
   - `gave_up` → `gave_up_<refusal>`.
   - `not_approved` → `not_approved_<reason>`. The Gate's reason is reduced to `[a-z0-9_]`, and an
     empty or unexpected one becomes `not_approved_unknown`.
   - An activity failure after its retries → `activity_failed`.
3. **A new `recordSubmissionEnding` activity** on the `pipeline` queue calls `recordDeadLetter`:
   - kind `apply.submission`, subject `application:<id>`;
   - key `application:<id>:submit`, so one per application ever;
   - attempts: 5 for `activity_failed`, otherwise the number of gateway calls made.

   `recordDeadLetter` writes the `dead_letter.recorded` feed event in the same transaction, so each
   ending gives exactly one dead letter and one event. A retried call stores nothing more.
4. **The workflow records the ending, then returns the same result.** On an activity failure it
   records `activity_failed` and then rethrows, so Temporal still shows the failure.
   - The record activity retries until the database is back, at most 5 minutes apart, like the
     sweep's.
   - Bad input (`InvalidInput`) is not retried.
5. **Checked again at the boundary:** both ids are uuids, and the reason code matches the
   dead-letter pattern. A malformed letter is a non-retryable `InvalidInput`.

## Acceptance criteria
- [ ] `endingLetter` maps every result kind as above, and refusals and reasons become valid reason
      codes.
- [ ] The activity on PGlite stores one dead letter and one `dead_letter.recorded` event. A second
      call stores nothing more.
- [ ] The activity refuses a bad application id or reason code as `InvalidInput`.
- [ ] The workflow bundle still builds.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope (follow-up issue, Parent: #231)
- Item 2 of #231: ids instead of the package in the workflow's input and the activity's arguments,
  loading the package through `packages/db`, or a payload codec with an ADR. This needs a package
  reader in `packages/db`, which another agent is changing now.

## Decisions (ADR-0016)
- **The issue is split.** Item 1 is here; item 2 goes to a follow-up for the reason above.
- **The workflow's input gains a field without `patched`.** No worker runs it yet (#230), so no
  history in flight can break.
- **No new event type.** `recordDeadLetter`'s own event is the one feed line.

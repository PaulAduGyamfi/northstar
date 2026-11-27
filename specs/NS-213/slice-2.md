# NS-213 slice 2: relay the Gate's package decisions to waiting submission workflows

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #195 item 2 (parent #69); slice 1 (`spec.md`) was item 1.
Requirements: APR-001, APPLY-003, RES-006 · ADR-0001, ADR-0002, ADR-0007, ADR-0017
Rules that apply: `.claude/rules/worker.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
A submission workflow waits for the Gate's decision as a signal (`approval` or `withdrawn`), and
the client helper can send both (NS-225 slice 2), but nothing sends them. Without a relay, every
package round's workflow would wait for ever, whatever Paul decides in the Queue.

## Behavior
- `readPackageSignals(db, candidateId)` (`packages/db`, `package-signal-read.ts`, read-only, no
  migration) lists the `application_package` requests whose outcome is settled, by the Gate's own
  clock (`northstar_gate_now()`), in the last 7 days (`RELAY_WINDOW_DAYS`), newest first, at most
  200 (`RELAY_LIMIT`), each with its package round (`applicationId`, `packageSha256`):
  - `withdrawn`: the request was withdrawn, or its live (not undone) decision is a rejection
    that has taken effect;
  - `approval` with the decision id: its live decision is an approval that has taken effect (past
    the undo window) and the request isn't withdrawn.
  A decision still inside its undo window is left out: once a run has a decision it keeps it, so
  an approval relayed and then undone would end the round as `not_approved`, and that round's
  workflow id could never run again. Ids and hashes only; never the package.
- `relayPackageDecisions` (`apps/worker`, `src/activities/relay.ts`, on `pipeline`) reads them
  and, for each round whose workflow is running and still waiting for a decision, sends
  `signalApproval` or `signalWithdrawn`. A round with no running workflow, or one that already has
  a decision, gets nothing, so repeated passes never grow a run's history. It returns counts
  only (`signalled`, `skipped`, `failed`). A round whose Temporal call fails doesn't stop the
  rest: the pass fails after trying every round (`RelayRoundsFailed`). "No such workflow" is the
  client's `WorkflowNotFoundError` or a gRPC NOT_FOUND (`isNotFound`): the worker's own client is
  marked experimental in the SDK, with error handling that may differ.
- The submission workflow answers a `waiting` query (true until it has a decision or a
  withdrawal). Queries don't change a run's history, so in-flight runs need no `patched`.
- `TemporalPort` gains `waiting(workflowId)`: false when no such workflow runs (described first,
  so a closed run is never replayed for the query).
- `packageSignalRelayWorkflow` (`src/workflows/relay.ts`, on `pipeline`) runs a pass per
  candidate every minute (input), continuing as new after 100 passes. A pass that fails its 3
  attempts becomes a dead letter (kind `apply.signal_relay`, reason `relay_failed`, one per
  workflow run, so a lasting failure writes one per 100 passes, not one a minute) and the next pass tries again. The activity reaches Temporal through the worker's own
  client (`Context.current().client`): no second connection.
- The worker process ensures the one relay (`ensureSignalRelay`, fixed id `package-signal-relay`,
  conflict `USE_EXISTING`) at start, like the sweep.

## Acceptance criteria
- [x] The read: effective approvals, effective rejections and withdrawals, never a decision in
      its undo window, an undone one, another kind or another candidate's (PGlite tests).
- [x] The activity signals only waiting runs, the right signal per outcome, skips the rest, and
      a failing round doesn't stop the others.
- [x] The `waiting` predicate (`stillWaiting`) is tested; the bundle builds with the relay. The
      relay workflow's dead-letter path and the query handler are read, not run: there is no
      Temporal test server here (the sweep's precedent).
- [x] `main.ts` ensures the relay; lint, typecheck, test and build green for db, worker and web;
      docs.

## Failure modes
A failed read or Temporal call fails the pass; it's retried, then a dead letter, and the next
pass reads again. Signals are idempotent (the workflow keeps its first decision).

## Observability
The activity's counts in its result (Temporal history); a failed pass is a dead letter on
`/health`. The decisions themselves are already in the feed (`approval.*`).

## Decisions made without Paul (ADR-0016)
- Relay only effective decisions (the undo reason above), and a 7-day window: a round whose
  workflow starts more than 7 days after its decision isn't relayed (its starter starts the
  workflow when it files the package).
- At most 200 rounds a pass, newest first: rounds whose runs already ended still count for 7
  days, so past 200 settled rounds in a week the oldest waiting ones would drop out. Under the
  25-a-day apply cap that is out of reach for one candidate.
- A new dead-letter kind, `apply.signal_relay` (the column's pattern check allows it; no
  migration).

## Out of scope
- Starting submission workflows (the package step's caller).
- A pushed signal from the Queue's decide path; the relay's one-minute delay is accepted.

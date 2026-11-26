# NS-220: Schedule the Apply Gateway's stale-claim sweep from the worker (slice 1: the workflow)

Status: approved under ADR-0016 (autonomous lane)
Requirements: APPLY-007, APPLY-009, RES-007
Rules that apply: ADR-0001, ADR-0002, ADR-0007, ADR-0016, `.claude/rules/worker.md`, `.claude/rules/gateways.md`

## Why
A submission claim whose run died stays "in progress" until the same application comes round
again, which holds its ATS lane. `sweepStaleClaims` (NS-143, NS-177) closes such claims as
`needs_human`, but nothing runs it.

## Behavior
- `staleClaimSweepWorkflow` (`apps/worker`, on the `pipeline` queue) runs one sweep pass per
  candidate, then sleeps a durable interval (default 5 minutes), again and again. After 100 passes
  it continues as new, so its history stays small.
- Each pass is the `sweepStaleClaims` activity on `pipeline` (database only, no browser): it calls
  the gateway's `sweepStaleClaims` with `dbSweepPorts` (wired by the worker process, NS-225) and
  returns how many claims it closed. One-minute start-to-close, 3 attempts with backoff. Safe to
  repeat: a second sweep finds nothing.
- A pass that still fails after its attempts is never dropped silently (ADR-0007): the
  `recordSweepFailure` activity stores a dead letter (`recordDeadLetter`: kind
  `apply.stale_sweep`, subject `candidate:<id>`, reason `sweep_failed`, attempts 3, keyed by the
  workflow run and pass), and the next pass tries again. The gateway's `apply.sweep` span already
  marks the failure.
- Which candidates to sweep, and the interval, are workflow input.

## Acceptance criteria
- [ ] The sweep activity returns the closed count and lets a failure through for the retry
      policy (unit tests with fake ports).
- [ ] The failure activity records one dead letter with the right shape, and recording it twice
      stores one (PGlite test).
- [ ] The workflow bundles for Temporal's sandbox (the existing bundle test, now with both
      workflows).
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- Database down: the pass fails, is retried 3 times, then becomes a dead letter; if even that
  fails, the workflow fails visibly in Temporal.
- A slow pass: the 1-minute limit stops it, and its retry is safe.

## Observability
The gateway's `apply.sweep` span, the `dead_letter.record` span and the dead-letter row.

## Out of scope (follow-ups)
- The test from #214's done-when that the sweep runs on its interval and closes a stale claim
  in Temporal's test environment: that environment needs `temporal.download` (NS-224, #229).
- Starting the workflow (one per worker deployment) and passing `loadApplyLimits` to `dbPorts`
  from the worker process: NS-225 (#230).

## Open questions
None blocking.

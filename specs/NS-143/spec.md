# NS-143: Surface stale apply claims and take pacing limits from config

Status: accepted (autonomous lane, ADR-0016)
Requirements: APPLY-007, APPLY-009
Rules that apply: ADR-0002, ADR-0007, ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/db.md`
Parent: #19 (NS-120)

## Why
In NS-120's submission ledger a run that dies after claiming leaves an `in_progress` row. It only
becomes `needs_human` (`outcome_unknown`) when the same application is submitted again after
15 minutes. Until then every other application on that ATS gets `AtsBusy` and nothing shows the
stuck claim. And the daily cap and minimum gap come from optional `claimSubmission` arguments, so
any caller could raise them.

## Behavior
1. **Stale-claim sweep.** `listStaleClaims(db)` (packages/db) returns every `in_progress` claim
   that started at least `CLAIM_STALE_AFTER_MS` ago by the database clock.
   `sweepStaleClaims(ports)` (packages/gateways) closes each one exactly as a repeated
   `submitApplication` does today: the ledger row becomes `needs_human` (`outcome_unknown`), which
   frees the ATS lane, then the application moves to `needs_human` through
   `transitionApplication` with the gateway's key namespace
   (`application:<id>:apply:<submissionId>:<to>`), via `submitting` if the run died before it
   moved there. Both paths share one helper, so they can't drift. A claim closed by someone else
   in between is skipped, not an error. It never retries a submission.
2. **Pacing from config.** `claimSubmission` takes no `dailyCap`/`minGapMs` on its input.
   It reads an `ApplyLimits` value, which only `loadApplyLimits(env)` (one typed config module,
   `APPLY_DAILY_CAP`, `APPLY_MIN_GAP_SECONDS`) or `DEFAULT_APPLY_LIMITS` can produce (a branded
   Zod type). The config may lower the limits, never raise them past APPLY-007's defaults
   (25 a day, 90 s apart). `dbPorts` takes the limits once, from the entry point.

## Acceptance criteria
- [ ] A claim in progress for 15 minutes is listed; one for less is not; finished claims never are.
- [ ] The sweep marks a stale claim `needs_human` (`outcome_unknown`), moves its application to
      `needs_human`, and a claim on the same ATS succeeds afterwards (PGlite).
- [ ] The sweep leaves a live claim alone, and a second sweep changes nothing.
- [ ] A stale claim whose run died before moving to `submitting` still reaches `needs_human`.
- [ ] Sweep and a repeated `submitApplication` write the same events (one helper).
- [ ] `ClaimInput` has no pacing fields; the cap and gap come from `ApplyLimits`.
- [ ] `loadApplyLimits` defaults to 25 and 90 s, accepts lower values, refuses higher, zero,
      negative or non-integer values, naming the setting.

## Failure modes
- Database down: the sweep throws; the caller (a future worker) retries on its next tick. A
  claim not yet closed is listed again. One claim that fails doesn't stop the others: the pass
  closes the rest, then throws the first failure.
- A crash between the ledger write and the application move (two transactions, as in NS-120)
  leaves the ledger at `needs_human` and the application behind. Neither path repairs it today;
  the follow-up issue adds that repair.
- A run that is not actually dead after 15 minutes: impossible by the gateway's step timeouts
  (they add up to far less); if it happens, its `recordSubmitted` is refused and it throws
  `ApplyInvariantError` loudly, as today.

## Observability
- `apply.sweep` span with `northstar.apply.stale_count` and `northstar.apply.failed_count`; the
  existing `db.apply.needs_human` span and `apply_submission.needs_human` event per closed claim,
  and the application's status event.

## Out of scope (follow-up issue)
- Item 3 of #78, the composite foreign key scoping `apply_submission.application_id` to its
  candidate. It needs a migration, and only one agent at a time may change migrations; filed as an
  `agent-filed` follow-up.
- Scheduling the sweep: there is no worker yet (NS-157), and nothing can claim a submission until
  the Playwright driver lands. The follow-up wires it into the worker.

## Open questions
- Whether Paul ever wants the cap above 25: the config refuses it for now (decision recorded in
  the PR).

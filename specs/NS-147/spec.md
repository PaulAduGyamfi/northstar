# NS-147: Wire breakers and kill switches into callers (slice 1: board polling)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RES-002 (per-dependency circuit breakers), RES-008 (kill switches per subsystem).
GitHub issue #87 (`agent-filed`, `Parent: #25`). The rest of #87 is split into follow-up issues
(see "Out of scope").
Rules that apply: ADR-0007 (fault isolation, items 3 and 6), ADR-0015 (plain board scheduler),
AGENTS.md (fail small; never a silent drop), `.claude/rules/tests.md`.

## Why
NS-126 built stored breakers and kill switches, but nothing calls them, so Paul can't stop board
polling for one ATS and a failing ATS is hit by every board on it. Board polling is the first
caller: it already runs on its own (`jobs poll`, `jobs run`), it already uses the database, and
it needs no schema change.

## Behavior
For each due board in `pollDue` (`packages/sources/src/poll.ts`), before reading it:
1. **Kill switch.** If subsystem `source:<ats>` is switched off (`isSubsystemOn` is false), the
   board is not read and not recorded: it stays due and is read on the first pass after the
   switch is turned back on. It counts as `paused`.
2. **Breaker.** `acquireCall` for dependency `source:<ats>`. Refused: the board is not read and
   not recorded (the work waits, RES-002), and it counts as `paused`. Allowed: the board is read.
3. **Outcome.** Only the board read counts toward the ATS's breaker: a successful list is
   `{ ok: true }`, a list that throws is `{ ok: false, error: <error name> }`. Saving postings
   (our database) never counts against the ATS. A probe passes its `probeToken` back.
4. **Guard failures fail safe.** If the switch or breaker check throws (Postgres down), the board
   is treated as paused and not read. If reporting the outcome throws, the board's result is
   still recorded, and the span says the report failed.
5. The pass summary gains an optional `paused` count (set only when a board was held back), and
   `jobs poll` prints it.
6. The guard is a required dependency of `pollDue` (`PollDeps.guard`), wired in `bin.ts` to
   `isSubsystemOn`, `acquireCall` and `recordCallOutcome` for the sole candidate.

## Acceptance criteria
- [ ] A board whose `source:<ats>` switch is off is not fetched or recorded; boards on other
      ATSs in the same pass still poll.
- [ ] A board whose `source:<ats>` breaker refuses the call is not fetched or recorded.
- [ ] A successful board read reports success to `source:<ats>`; a failed read reports failure
      with its error name; a save failure reports success for the read.
- [ ] A probe's `probeToken` is passed back with its outcome.
- [ ] A guard that throws holds the board back without reading it.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Postgres down:** the guard throws, every board is paused, nothing is fetched (fail safe).
- **The ATS fails for every board:** five failures in a row open `source:<ats>`, and the boards
  on it wait for the breaker's pause instead of each adding its own failed request. Each board's
  own backoff and quarantine (NS-115) are unchanged, because a refused board is not recorded.
- **One dead board among healthy ones on the same ATS:** successes in between reset the count, so
  it doesn't pause the others.

## Observability
The `source.poll` span is only started for boards that are read. A paused board gets a
`source.poll.paused` span with `source.ats`, `source.watch_id` and `source.paused_by`
(`kill_switch`, `breaker` or `guard_error`). `source.poll` gains
`source.breaker_report_failed` when reporting throws. Breaker and switch changes already write
their own domain events (NS-126).

## Out of scope (follow-up issues, `agent-filed`, `Parent: #25`)
- Breakers and switches around the LLM gateway (`anthropic`, `agent:<route>`), Gmail (`gmail`)
  and the Apply Gateway (`ats:<ats>`, `adapter:<ats>`, `auto_apply`).
- Dead-letter (RES-007): needs a new table, so a migration.
- Backpressure and quotas (RES-009), and timeouts (RES-005).
- RES-013 (health model): already built by NS-125, and outside parent #25's RES-001…009.

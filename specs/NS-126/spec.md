# NS-126: Resilience (slice 1: circuit breakers and kill switches)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RES-002 (per-dependency circuit breakers, state stored centrally), RES-008 (kill
switches per subsystem). The rest of RES-001…009 is split into follow-up issues (see "Out of
scope"). GitHub issue #25.
Rules that apply: ADR-0007 (fault isolation, items 3 and 6), ADR-0012 (events in the same
transaction), AGENTS.md (fail small; if it isn't in the feed, it didn't happen),
`.claude/rules/db.md`, `.claude/rules/tests.md`.

## Why
One failing dependency (the Claude API, Gmail, an ATS) must not drag the rest down, and Paul must
be able to stop any subsystem at once. Every later caller needs two questions answered from one
place: "may I call this dependency now?" and "is this subsystem switched on?".

## Behavior
1. **Breaker state machine** (`packages/domain`, `breaker.ts`, pure, time passed in):
   - `closed`: calls go through. `FAILURE_THRESHOLD` (5) failures in a row open it.
   - `open`: calls are refused until `retryAt`. The pause is `BASE_COOLDOWN_MS` (60 s), doubled
     each time it reopens without a success in between, up to `MAX_COOLDOWN_MS` (15 min).
   - Once `retryAt` passes, the next caller gets one **probe** and the breaker is `half_open`
     until `retryAt` + `PROBE_TIMEOUT_MS` (2 min). Other callers are refused meanwhile, and a
     probe that never reports is replaced once that time passes. The probe's success closes the
     breaker and resets it. Its failure opens it again with the doubled pause.
   - A success while closed resets the failure count.
2. **Stored breakers** (`packages/db`, `dependency_breaker`, `breaker-write.ts`): one row per
   candidate and dependency (`anthropic`, `gmail`, `ats:greenhouse`, …).
   - `acquireCall` says `allowed` (and whether it is the probe) or `refused` with `retryAt` and
     the last error name, so a UI can say "Gmail paused: RateLimited, retrying 14:05".
   - `recordCallOutcome` applies a success or a failure (error name only, never a message).
   - Both lock the row, so concurrent callers see one state.
   - An event is written only on a change of state: `breaker.opened`, `breaker.probing` and
     `breaker.closed`, with the dependency, failure count, pause and error name.
3. **Kill switches** (`packages/db`, `kill_switch`, `kill-switch-write.ts`): append-only rows. The
   newest row per subsystem is its state, and a subsystem with no row is on.
   - Subsystems: `auto_apply`, `outreach_send`, `inbox_auto_label`, `source:<x>`, `adapter:<x>`
     or `agent:<x>`.
   - `setKillSwitch` stores who set it and why, with a `kill_switch.set` event. Setting the
     same state again stores nothing.
   - `isSubsystemOn` reads the current state straight from Postgres, so a flip takes effect on
     the next check (RES-008's 10 s).
   - `readKillSwitches` lists the current state of each subsystem.

## Acceptance criteria
- [ ] Five failures open a breaker. While open, calls are refused with `retryAt`. After it, one
      probe is allowed and others are refused. A probe success closes the breaker, and a probe
      failure reopens it with a doubled pause, capped at 15 minutes (domain tests).
- [ ] A probe that never reports is replaced after the probe timeout.
- [ ] Stored breakers apply the same rules. Only changes of state write events, and those events
      carry no error message (db tests).
- [ ] A kill switch turned off makes `isSubsystemOn` false at once. Turning it on again restores
      it, and both changes are in the feed. Repeating the same state writes nothing. Unknown
      subsystem names are refused, and the rows can't be updated or deleted.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Postgres down:** `acquireCall` throws. Callers treat that as refused, and the work waits.
  This fails safe: no unguarded call goes out.
- **A caller crashes mid-probe:** the probe timeout lets another caller probe.
- **A caller never reports an outcome while closed:** nothing changes, and the breaker only acts
  on reported outcomes.

## Observability
`breaker.opened`, `breaker.probing`, `breaker.closed` and `kill_switch.set` domain events, in the
same transaction as the row they describe.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #25`)
- Wiring breakers and switches into callers: the LLM gateway, Gmail, board polling, and the Apply
  Gateway once merged.
- Dead-letter with retry, skip and hand off (RES-007).
- Bounded concurrency, daily caps and the LLM budget (RES-009).
- The health model (RES-013), the UI and the "paused" banner.
- Worker pools (RES-001), which need Temporal.
- Timeouts everywhere (RES-005), and the degradation matrix tests (RES-004).

## Open questions
1. **Thresholds** (5 failures, 60 s doubling to 15 min, 2 min probe) are defaults in code. Tune
   them per dependency when the callers are wired.
2. **Breakers are per candidate**, like every row (Q-02), though a dependency outage is global.

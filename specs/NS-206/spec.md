# NS-206: Kill switches and breakers in the Apply Gateway, the profile CLI and the API

Status: accepted (autonomous lane, ADR-0016)
Requirements: RES-002 (per-dependency breakers, each ATS domain), RES-008 (kill switches per
subsystem: auto-apply, each adapter, each agent)
Rules that apply: ADR-0002, ADR-0007, `.claude/rules/gateways.md`, `.claude/rules/tests.md`
Parent: #125

## Why
NS-174 gave the LLM gateway and the Gmail client a `CallGuard`, and the funnel and sources CLIs
wire it to the stored switches and breakers. The Apply Gateway, the profile CLI and the API still
act without asking, so flipping `auto_apply` off in the app wouldn't stop a submission, and an ATS
that keeps timing out keeps being driven.

## Behavior
1. **Apply Gateway** (`packages/gateways`). `ApplyPorts` gains `isSubsystemOn`, `acquireCall` and
   `recordCallOutcome`, which `dbPorts` wires to the existing `packages/db` functions. They are
   required: no gateway can be built without them.
   - After the Gate check and the file re-hash, and before the claim, `submitApplication` checks
     the `auto_apply` switch, then `adapter:<ats>`, then asks the `ats:<ats>` breaker.
   - Anything held back returns the refusal `HeldBack`, with `by` (`kill_switch`, `breaker`,
     `guard_error`), `what` (the switch or dependency) and `retryAt` (the breaker's time, else
     null). Nothing is claimed, no status moves and the browser never opens, so a later call
     simply retries. This is the "scheduled retry" of gateways.md. It is never a silent drop: the
     caller gets the refusal and the `apply.submit` span records `northstar.apply.outcome =
     HeldBack` and `northstar.apply.held_by`.
   - A check that throws (the database is down) holds back too (fail safe).
   - After the browser step, only the ATS's own trouble counts against its breaker. A step
     timeout (open or submit) is reported as a failure (`Timeout`). Any page the ATS served
     (confirmation, challenge, changed form, no confirmation) is reported as `ok`. A browser error
     that isn't a timeout isn't the ATS's fault and isn't reported. A report that fails is noted
     on the span and never changes the outcome.
2. **Profile CLI** (`packages/profile/src/bin.ts`): the model gateway gets a guard on the stored
   switches and breakers, as `packages/funnel/src/bin.ts` does. `safeErrorSummary` prints a
   `HeldBack` with `describeHeldBack`, for example "agent:profile-extract is switched off".
3. **API** (`apps/api`): the capture endpoint's lazily built model gateway gets the same guard
   (the candidate id is looked up lazily, as for saving). A `HeldBack` from the capture becomes
   503 with `held back (<describeHeldBack>)`, never a 500.

## Acceptance criteria
- [ ] With `auto_apply` off, `adapter:<ats>` off, or the `ats:<ats>` breaker open, a submission
      returns `HeldBack`, and claims nothing, moves nothing and opens no browser (fake ports;
      `auto_apply` off on PGlite through `dbPorts`).
- [ ] A guard check that throws holds the submission back (`guard_error`).
- [ ] Every allowed submission is reported to `ats:<ats>`: `ok` for a confirmation or a page the
      ATS served, a failure for a step timeout, nothing for another browser error. A probe's
      token is passed back.
- [ ] `safeErrorSummary(new HeldBack(...))` reads the switch or breaker in plain words.
- [ ] A capture whose model call is held back answers 503 naming the switch or breaker.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- Postgres down: the gateway's checks throw, so the submission is held back (`guard_error`). The
  CLI prints "the switch and breaker check failed …", and the API answers 503.
- A breaker probe is taken before the claim, and only the browser step reports it. Any path that
  returns before the browser leaves it unreported:
  - a claim refusal (duplicate requisition, ATS busy, paced, daily cap);
  - a replay or stale-claim close;
  - a `status_conflict` handoff;
  - a thrown invariant.

  The breaker then stays half-open until its 2-minute probe window ends, holding other
  submissions to that ATS back, and then another caller probes. That is bounded and fails safe.
  Asking the breaker after the claim would be worse: a held-back call would leave a claim
  behind. A probe that runs longer than 2 minutes has its report ignored as stale, so a slow
  success doesn't close the breaker.
- Because the checks come before the claim, a repeat call for an application already submitted
  or handed off gets `HeldBack` while a switch is off or the breaker is open, instead of its
  replayed outcome. A stale claim is then closed by `sweepStaleClaims` rather than by that call.
  The caller retries either way.

## Observability
`apply.submit` span: `northstar.apply.outcome` `HeldBack`, `northstar.apply.held_by`,
`northstar.apply.guard_error` (an error name only) and `northstar.apply.breaker_report_failed`.
Breaker changes already write `breaker.*` events (NS-126); kill-switch flips already write
`kill_switch.set`.

## Out of scope
- One shared db-backed guard helper (the issue's optional item). It would live in `packages/db`,
  which another agent holds now (ADR-0016). The three small copies stay until then.
- Kill switches for the sweep (`sweepStaleClaims`): it only closes dead claims and never contacts
  an ATS.

## Open questions
- `auto_apply` off holds every gateway submission, including ones Paul approved by hand. The
  gateway is the only thing that applies automatically. A by-hand application goes through a
  handoff, which this doesn't touch.

# NS-174: Wire breakers and kill switches into the LLM gateway and Gmail

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RES-002 (circuit breaker per dependency), RES-008 (kill switch per subsystem).
GitHub issue #125 (agent-filed, parent #87). The issue says each caller can be its own PR. This
PR covers the LLM gateway and Gmail. The Apply Gateway part goes to a follow-up issue.
Rules that apply: ADR-0007, `.claude/rules/gateways.md`, `llm.md`, `tests.md`.

## Why
NS-147 put board polling behind the stored kill switches and breakers. The model and Gmail
still call out unguarded:
- flipping `agent:<route>` off in the app doesn't stop a route;
- an Anthropic or Gmail outage is retried call after call instead of pausing.

## Behavior
1. **The guard** (`packages/llm/src/guard.ts`, exported). `CallGuard` has the same three methods
   as board polling's `PollGuard`: `isOn(subsystem)`, `acquire(dependency)` and
   `report(dependency, outcome, probeToken)`.
   - Its decision and outcome types copy `packages/domain`'s `CallDecision` and `CallOutcome`
     field for field. The packages/db functions therefore fit without `packages/llm` depending
     on `domain` or `db`, as the issue asks.
   - The caller passes the guard in.
   - **`HeldBack`** is the error a guarded call throws instead of going out:
     - `by` is `kill_switch`, `breaker` or `guard_error`;
     - `retryAt` is set for a breaker;
     - `retryable` is always true.

     A held-back call never reaches the dependency and is never reported to its breaker.
     The work isn't failed: a Temporal activity retries it later, and the CLIs that use it
     (the funnel backfill) are safe to rerun.
2. **LLM gateway** (`createLlmGateway({ client, now, guard? })`).
   - Before a route runs, its `agent:<route>` kill switch must be on.
   - The `anthropic` breaker must then allow the call.
   - A guard check that throws holds the call back (fail safe). The span gets
     `northstar.llm.guard_error` with the error's name, never its message.
   - The `llm.call` span records `northstar.llm.outcome = "HeldBack"` and
     `northstar.llm.held_by`.
   - **What is reported, only the dependency's own outcome:**
     - Any reply (Ok, Refused, Truncated, InvalidOutput) is a success.
     - A retryable transport error (connection, timeout, 408/409/429/5xx) is a failure named
       `LlmTransportError`.
     - A non-retryable API status (400, 401, 404) means the API answered; it is our request or
       key that's wrong, so it counts as a success for the breaker.
     - Any other error (a bug, a missing fixture) is not reported at all.
   - A probe passes its `probeToken` back.
   - A report that throws is noted on the span (`northstar.llm.breaker_report_failed`) and
     never changes the result.
   - Without a guard, the gateway behaves exactly as before (evals, tests).
3. **Gmail** (`createGmailClient({ ..., guard? })`).
   - The `gmail` breaker wraps each API read, after the client's own retries.
   - **What is reported:**
     - A success is ok.
     - A failure is reported only when it is Gmail's: no answer, 429, 5xx, or a rate-limit 403
       after the retries.
     - 401, 404 and other 403s are Gmail answering, so they are reported ok.
   - A refusal throws `HeldBack` before any request goes out.
   - Gmail has no kill switch in this ticket.
4. **Wiring.**
   - The funnel CLI guards Gmail and the `mail-classify` route.
   - The sources CLI guards `job-extract` and `job-match`.
   - Both use packages/db's `isSubsystemOn`, `acquireCall` and `recordCallOutcome` for Paul's
     candidate.

## Acceptance criteria
- [ ] With the switch off, a route doesn't call the client and throws `HeldBack(kill_switch)`.
      An open breaker throws `HeldBack(breaker)` with `retryAt`. A guard that throws gives
      `HeldBack(guard_error)` (llm tests).
- [ ] Each outcome kind reports as described, and a probe's token is passed back. A report that
      throws doesn't change the outcome (llm tests).
- [ ] Gmail: an open breaker sends no request. A 503 after retries is reported as a failure; a
      404 is reported ok; a success is reported ok (inbox tests).
- [ ] With no guard, every existing test passes unchanged.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope (follow-up issue)
- The Apply Gateway's `ats:<ats>`, `adapter:<ats>` and `auto_apply` checks. Another agent holds
  the apply area right now (NS-139).
- Wiring the guard in the profile CLI and the API. Their packages are held by NS-133 and NS-139.

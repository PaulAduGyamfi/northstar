# NS-154: Run inspector (steps, timings, LLM calls)

Status: accepted (autonomous lane, ADR-0016)
Requirements: OBS-003
Rules that apply: ADR-0012, ADR-0018, `.claude/rules/db.md`, `.claude/rules/web.md`,
`.claude/rules/tests.md`
Parent: #24

## Why
A feed line says what happened, not how. OBS-003 asks that expanding a feed event shows the run
behind it: its steps and timings, its LLM calls (prompt version, model, tokens, cost), retries and
errors. The pieces exist (events carry a `traceId`; some carry an LLM call record in
`payload.call`) but nothing collects them.

## Behavior
1. **packages/db** (`run-read.ts`, a read only, no migration): `readRun(db, candidateId, position)`
   - returns null when the candidate has no event at that position;
   - an event without a `traceId` is a run of one step;
   - otherwise every event of the same candidate with the same `traceId`, oldest first, at most
     200 (`truncated` says when there were more);
   - each step: position, time, type, actor, its feed line (`feedLine`, never stored text), the
     milliseconds since the run's first step, and its LLM call if the payload carries one. The call
     is copied field by field from `CallRecord`'s ids, versions and numbers (route, prompt id and
     version, models requested and served, tokens, latency, cost, stop reason, refusal category,
     fallback); anything else in the payload is never returned;
   - totals: steps, LLM calls, input and output tokens, known cost and how many calls had no known
     price, the run's duration.
2. **apps/api**: `GET /feed/run?position=` (`auth: "session"`): the run, 404 when there is none,
   503 when it can't be read, 400 for a position that isn't one.
3. **apps/web**: each feed line on Today gets a "Show the run" button that fetches the run only
   when Paul asks and lists its steps with their offsets, each LLM call's route, prompt version,
   model, tokens and cost, and the totals. Plain logic in `src/run.ts`.

## Acceptance criteria
- [ ] `readRun` gathers only the same candidate's events with the same trace, in order, and
      returns one step for an event without a trace and null for an unknown position.
- [ ] A step's call carries only the listed fields even when the payload holds more (a test with
      extra text in the payload).
- [ ] Totals add tokens and known costs and count calls without a price.
- [ ] The endpoint refuses without a session (401), answers 404, 400 and 503 as above.
- [ ] The web logic formats offsets, tokens and cost, and shows "price unknown" for a null cost.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
Postgres down: 503, and the button says the run can't be read right now. A timeout says "No
answer in time." Nothing else on Today changes.

## Observability
A `run.read` span with the step count; `api.request` spans per call.

## Out of scope
- Workflow steps from Temporal history: there is no worker process or client yet (NS-225).
- An index on `domain_event.trace_id` (a migration): the query is scoped to one candidate and run
  only when Paul clicks; it can come with a later migration if it gets slow.

## Decisions made without Paul (ADR-0016)
- **No migration in this slice:** the run is read without a new index (see Out of scope), so this
  ticket never takes the one-migration-at-a-time slot.
- **Retries and errors** are shown as the steps they already are (their events and feed lines,
  plus each call's stop reason, refusal and fallback); there is no separate retry record to read
  until the worker exists.

# NS-208: Funnel metrics, time in stage, and source and band analytics in the app

Status: accepted (autonomous lane, ADR-0016)
Requirements: DSH-002 (funnel, time in stage), DSH-004 (response rate by source, band, time to
apply), DX-003 (no rate from too few data points)
Rules that apply: `.claude/rules/db.md`, `.claude/rules/web.md`, `.claude/rules/tests.md`
Parent: #119

## Why
The Pipeline shows where each application stands, but not how the funnel performs or which
sources and fit bands get replies.

## Behavior
1. **packages/domain** (plain code, no I/O):
   - `wilson(k, n)` moves here from `packages/funnel` (which re-exports it), so both reports use
     one method.
   - `pipelineMetrics(histories, now)`, from each application's status moves:
     - the funnel: discovered (every application) → applied (reached `submitted`) → responded
       (reached `in_process`, `offer` or `rejected` after applying) → interviewing (reached
       `in_process`) → offer. Each step's rate is `k of n` with its Wilson interval;
     - time in stage: the median days from discovered to applied, and from applied to the first
       response;
     - response rate (responded ÷ applied) by source (the job's ATS, or `other`), by fit band and
       by time from posting to applying (under 1 day, 1–3 days, over 3 days, unknown).
     A rate with fewer than 20 data points reads as not enough data (DX-003), never a percentage.
2. **packages/db** (`pipeline-read.ts`, read only): `readApplicationHistories` gives, per
   application, its creation time, source, newest fit band, the job's posting time and its status
   moves (from `application.*` events, oldest first). Never a title, company or text.
3. **apps/api**: `GET /pipeline/metrics` (session only) returns the computed metrics; 503 when
   they can't be read.
4. **apps/web**: `/pipeline/metrics`, linked from the Pipeline page: the funnel with counts,
   rates and intervals, the times in stage, and the breakdowns, each with its sample size.
   `src/metrics.ts` holds the plain words.

## Acceptance criteria
- [ ] Synthetic histories give the expected counts, rates, medians and breakdowns (tests).
- [ ] A rate with fewer than 20 data points says not enough data yet.
- [ ] `packages/funnel`'s report still uses the same `wilson` (its tests unchanged and green).
- [ ] The endpoint refuses without a session (401) and answers 503 when the read fails.
- [ ] No event or span written here carries a title, company or email (it writes none).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
API or Postgres down: the page says so and shows nothing else.

## Observability
A `db.pipeline.histories` span with the application count; `api.request` per call.

## Out of scope
- Screen and onsite stages: the status machine has `in_process` only; they come with NS-164's
  mail triage. Shown as "interviewing".
- Response rate by resume variant: no application records which tailored version it used yet
  (NS-161 stores no package). Shown as not tracked yet.

## Decisions made without Paul (ADR-0016)
- **Minimum sample 20**, the same as the funnel report's DX-003 rule.
- **Stages from the status machine**, not mail, so the numbers match the Pipeline board.
- **`wilson` moves to `packages/domain`** so the API needn't depend on `packages/funnel` (a new
  workspace dependency and lock-file change) while keeping one method.

# NS-199 (#172, titled NS-197): Narrow the fresh-job alert read (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: SRC-015 · RES-* (fail small: a pass stays cheap as the job count grows)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
Each scoring pass runs the fresh-job alert pass, and `readAlertCandidates` reads every fit score
Paul has ever had to find the few jobs that could still alert. Only two kinds of job can:
- one under an hour old;
- one whose alert was held in quiet hours and hasn't gone out yet.

As the job count grows, each pass reads more than it needs.

## Behavior
- `readAlertCandidates(db, candidateId, freshSince)` reads only these ready jobs:
  - jobs whose age time (`posted_at`, or `first_seen_at` when there is none: the rule `ageHours`
    uses) is after `freshSince`;
  - jobs with a `job.fresh_alert_held` event and no `job.fresh_alert`.

  For those jobs it reads their scores, sources and alert events, exactly as before.
- The caller (`packages/sources` bin) passes `freshSince(now)` (`now − FRESH_MINUTES`, tested), using the same `now` it gives
  `alertPass`. The policy (60 minutes) stays in `packages/sources`.
- The jobs it returns, and every alert decision, are unchanged for any job that could still
  alert. A job that is neither fresh nor held is no longer read; it could only ever give
  `already_alerted` or `not_fresh`, which do nothing.

## Acceptance criteria
- [ ] A queue-band job whose age time is before `freshSince` and that has no held alert is not returned (test).
- [ ] An old job with a held, unsent alert is still returned, so it goes out after quiet hours (test).
- [ ] An old job whose held alert was already sent is not returned (test).
- [ ] A job with no `posted_at` is judged by `first_seen_at`, and a `posted_at` in the future still counts as fresh (tests).
- [ ] The existing `readAlertCandidates` and `alertPass` tests still pass unchanged in what they assert.
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` and `node evals/dist/bin.js --all` pass.

## Failure modes
Unchanged: a database error fails the alert pass, which never fails scoring (`scoreThenAlert`)
and is retried on the next pass.

## Observability
Unchanged (`sources.fresh_alerts` span with sent, held and released counts).

## Out of scope
- The PWA push (item 1).
- Quiet hours as an in-app setting (item 2, a schema change).
- An index on the age time (none is needed at Paul's scale; a migration would wait for the lane).
- A bound on held alerts: a held job that leaves the queue band, or closes, before quiet hours end
  keeps its held event and is read on every pass. That is a few rows at Paul's scale.

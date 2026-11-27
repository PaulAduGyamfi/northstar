# NS-130 slice 2: Career directions from the job feed (DNA-004)

Status: draft (autonomous lane, ADR-0016)
Requirements: DNA-004 (`docs/requirements/07-profile-optimization.md`), MAT-002
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/tests.md`

## Why
DNA-004: "Career directions lead to action." Each direction is a kind of role that is open now,
ranked by how much of what those jobs ask for Paul's work already proves. It shows the evidence,
the main gaps and how many fresh open jobs fit, so Paul goes straight to the queue rather than
reading a horoscope.

## Behavior
`careerDirections(jobs, profile, now)` in `packages/sources/src/fit/directions.ts` is plain code,
with no model, database or network.

- **Input:** ready jobs whose postings aren't known to be closed (what `readScorableJobs` gives),
  each with its id, title, must-have requirements and when it was posted (or first seen). Paul's
  `ScoringProfile` is the same one the Fit Score reads.
- **Role families:** a job's title (its first 200 characters: titles are untrusted) is lower-cased
  and cut at the first `,`, spaced hyphen, en or em dash, ` | ` or `(`.
  Seniority words (`senior`, `sr`, `junior`, `jr`, `staff`, `principal`, `lead`, `i`, `ii`, `iii`,
  `iv`) are dropped, and spaces are collapsed. "Senior Backend Engineer (Payments)" and "Backend
  Engineer II" are one family, "backend engineer". A job with no title, or nothing left after
  this, joins no family.
- **Thin families are left out:** a family needs at least 2 jobs (`MIN_DIRECTION_JOBS`), so one
  posting isn't presented as a direction.
- **Coverage:** each job's must-haves go through `matchRequirements`, the Fit Score's own rule. A
  family's coverage is its matched must-haves over all its must-haves, as a whole percent. A
  family with no must-haves has `null` coverage and ranks last.
- **Each direction lists:**
  - its matched atoms with how many requirements each met (its evidence);
  - its 5 most frequent unmatched must-haves (its main gaps; ties go to first seen);
  - its job count;
  - the ids of its fresh jobs, posted within 7 days before `now` (`FRESH_DIRECTION_DAYS`; a date
    after `now` is not fresh), freshest first, for a link straight to them in the queue.

  A requirement a job lists twice counts twice in coverage (two of its lines) but is one gap for
  that job, since gaps count jobs.
- **Order:** coverage first, then fresh jobs, then all jobs, then the family's name.

Requirement text comes from job postings, which are untrusted. It is only counted and shown back
as data, never acted on.

## Acceptance criteria
- [ ] Seniority words and title suffixes fold into one family; a family of one job is left out (tests).
- [ ] Coverage is matched over total must-haves, using `matchRequirements` (test).
- [ ] Gaps are the most frequent unmatched must-haves, at most 5, ties by first seen (test).
- [ ] Fresh jobs are those posted within 7 days, freshest first; an undated job isn't fresh (test).
- [ ] Ranking: coverage, then fresh count, then job count, then name; `null` coverage last (test).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` and `node evals/dist/bin.js --all` pass.

## Failure modes
None: a pure function. No jobs, or no profile atoms, gives no directions or 0 % coverage, never an
error.

## Observability
None in this slice (no caller). The caller that shows directions emits counts only.

## Out of scope
- A caller, CLI or page, and storage (DNA-008).
- Nice-to-haves (DNA-004 says "requirements"; must-haves are what fit rests on).
- The model-assisted match (NS-138): it is off by default and costs a call per job.

## Open questions
Under Paul's delegation (2026-11-26): the family rule, the minimum of 2 jobs, the 7-day freshness
window and the 5 gaps are defaults, recorded in the PR.

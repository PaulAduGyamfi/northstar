# NS-130 slice 3: Evidence gaps suggest proof-of-work tracks (DNA-006)

Status: draft (autonomous lane, ADR-0016)
Requirements: DNA-006 (`docs/requirements/07-profile-optimization.md`), GRW-008, MAT-005
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/tests.md`

## Why
DNA-006: "Dimensions or directions held back by weak proof suggest a proof-of-work track." Paul
should see where his evidence is thin, and what the market keeps asking for that he can't prove
yet, as a short list of tracks worth starting. A suggestion is never a track he didn't choose.

## Behavior
`evidenceGaps(dimensions, directions, tracks)` in `packages/profile/src/career-dna/gaps.ts` is
plain code, with no model, database or network.

- **Dimension gaps:** each report dimension in the `not_enough` or `low` band becomes "Build proof
  for <label>", in rubric order, with its band and evidence count.
- **Requirement gaps:** a direction's must-have gap counts when it meets both thresholds:
  - at least 2 of the direction's jobs ask for it (`GAP_MIN_JOBS`);
  - those jobs are at least 25 % of the direction's jobs (`GAP_MIN_SHARE`).

  The same requirement (case- and spacing-blind) is listed once, from the direction where its
  share is largest. Gaps are ordered by share, then jobs.
- **Already covered:** a gap is skipped when an `active` or `backlogged` growth track names it,
  as whole words and ignoring case, either way round. A `done` or `paused` track doesn't cover it.
  Only the first 200 characters of a requirement are compared, because postings are unbounded.
- **Suggestions only:** nothing writes a track (GRW-009's drafts come later). Requirement text
  comes from postings: it is untrusted, and only shown back.

## Acceptance criteria
- [ ] Low and thin dimensions are suggested in rubric order; medium and high ones are not (test).
- [ ] Requirement gaps need 2+ jobs and a 25 %+ share, ordered by share (tests).
- [ ] A requirement shared by two directions is listed once, from the larger share (test).
- [ ] Active or planned tracks cover a gap either way round, as whole words; done or paused tracks don't (tests).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` and `node evals/dist/bin.js --all` pass.

## Failure modes
None: a pure function. Empty inputs give no suggestions.

## Observability
None (no caller).

## Out of scope
- Writing tracks, or GRW-009's proof-of-work drafts.
- Interview weak spots (CAL-007), and re-weighting existing tracks (GRW-008).
- A caller or page.

## Open questions
Under Paul's delegation (2026-11-26): the 2-job and 25 % thresholds, the coverage rule, and that
`backlogged` tracks count as planned, are defaults recorded in the PR.

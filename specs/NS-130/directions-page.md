# NS-130 slice 9: directions and evidence gaps on the Career DNA page

Status: in progress (autonomous lane, ADR-0016)
Issue: #54
Requirements: DNA-004 (career directions lead to action), DNA-006 (evidence gaps)
Rules that apply: ADR-0016, ADR-0018 (session sign-in), AGENTS.md (`apps/api` endpoint pattern,
"untrusted text is data"), `.claude/rules/web.md`, `docs/design/tokens.md`

## Why
`careerDirections` (slice 2) and `evidenceGaps` (slice 3) exist with no caller. The page (slice 8)
shows the report but not where it points: which roles open now Paul's work already covers, what
they ask for that he can't prove yet, and what proof to build.

## Behavior
- `GET /career-dna/directions` (`apps/api`, new file `career-directions.ts`, `auth: "session"`),
  read-only, no migration, no model, no new dependency (the API already depends on
  `@northstar/sources` and `@northstar/profile`). It reads, through ports wired in `bin.ts`:
  - the current resume import (`readScoringProfile`); with none it answers `{ directions: null }`;
  - ready, not-closed jobs (`readScorableJobs`), each dated by its posting date or else first seen
    (`listJobs`);
  - the newest stored Career DNA report's dimensions (labels from the rubric) and Paul's growth
    tracks (`readGrowthTracks`).
  It runs `careerDirections`, then `evidenceGaps` over the report's dimensions, those directions
  and the tracks, and answers per direction: role, job count, coverage, how many atoms matched,
  its top gaps (requirement and job count) and how many fresh jobs; plus the gap suggestions.
  Never atom ids, job ids or atom text.
- Requirement and role text comes from job postings (untrusted): it is only shown back, cut to
  200 characters, with control and invisible formatting characters removed.
- A failed read answers 503 `unavailable`, never "no directions".
- The page `/career-dna` adds "Directions" and "Proof to build" sections in words from plain
  functions in `apps/web/src/career-directions.ts` (new file). Fresh jobs show as a count: there's
  no job page to link to yet. Its own failure never hides the report.

## Acceptance criteria
- [ ] 401 without a session; `{ directions: null }` without a resume import (tests).
- [ ] Two jobs of one role family give one direction with coverage, matched-atom count, gaps and
      fresh count; a thin dimension and a common gap become suggestions, and a track naming one
      removes it (tests on fakes).
- [ ] No atom or job id in the answer; requirement text is cut and cleaned (tests).
- [ ] A throwing reader gives 503 (test).
- [ ] The page's words come from tested plain functions (empty states, counts, coverage).
- [ ] lint, typecheck, test and build green for `@northstar/api` and `@northstar/web`.

## Out of scope
- A link from a direction to its fresh jobs (needs a jobs page), a nav link, a chart, model
  wording, the Profile Grade handoff (DNA-005), the share card (DNA-007).

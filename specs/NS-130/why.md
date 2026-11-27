# NS-130 slice 11: the "why" for each job on /jobs

Status: in review (PR)
Requirements: UX-014 (every score has a why), MAT-003 (fit bands), DNA-004 (directions link here)
Rules that apply: `.claude/rules/web.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
Slice 10 put Paul's scored jobs on `/jobs` with a score, a band and a reason code. The evidence
behind each number is only in `jobs why <id>` on the command line. UX-014 asks for a "why" next to
every score.

## Behavior
- `packages/db`: `readFitWhy(db, { candidateId, jobIds })` (read-only) gives each job's newest
  score's evidence (`fit_score.evidence`), at most 100 ids.
- `GET /jobs` (`apps/api/src/jobs.ts`): each scored job gains `why`, built field by field:
  - `title`, `pay`, `place`: the check's status code (`exact | partial | none | unknown`,
    `ok | below | unknown`, `ok | mismatch | unknown`), and `levelMismatch`;
  - `mustHave`: matched and total must-have requirements (counts only);
  - `missing`: up to 5 unmatched must-have requirements, the posting's own words through
    `postingText`;
  - `dealbreaker`: a flag only, never Paul's dealbreaker words.

  No atom id, atom text, matched requirement or nice-to-have leaves the API. A job whose stored
  evidence doesn't parse gets `why: null`; an unreadable evidence read leaves every `why` null and
  the list still answers.
- `/jobs` (`apps/web/src/jobs.ts`): `whyLines` words it under each job ("Title: close match", "Pay:
  below your floor", "Must-haves: 4 of 6 backed by your experience", "Not shown in your
  experience: Kubernetes, Terraform"). An unknown code is left out, never shown raw.

## Acceptance criteria
- [x] `readFitWhy` returns the newest score's evidence per job and nothing for
      another candidate's job.
- [x] `GET /jobs` gives each job its `why` with counts, codes and at most 5 cleaned unmatched
      must-haves, and no atom id or text (a test checks the body).
- [x] A failed evidence read keeps the list and sets `why` to null.
- [x] `whyLines` words every code and leaves out an unknown one.
- [x] `pnpm --filter @northstar/db --filter @northstar/api --filter @northstar/web lint typecheck
      test` pass.

## Out of scope
A nav link, a chart, showing which atom backs a requirement (the CLI keeps that), the Profile Grade
handoff and the share card.

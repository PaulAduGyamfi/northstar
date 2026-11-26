# NS-173: SmartRecruiters apply adapter and posting liveness checks

Status: accepted (autonomous lane, ADR-0016), in two slices
Requirements: APPLY-002 (SmartRecruiters, P2), SRC-010 · ADR-0002, ADR-0003, ADR-0007
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
APPLY-002 lists SmartRecruiters among the P2 adapters, and boards on it are already polled
(NS-115), so its jobs reach the queue but can't be applied to. SRC-010 asks that queued postings
are re-checked and closed ones marked, so the gateway never applies to a dead posting.

## Slices
The two parts share nothing but the ticket, and together they pass the size guideline (ADR-0016),
so they land as two PRs on this issue (as NS-140 did).

### Slice 1: the SmartRecruiters adapter (this PR)
1. `APPLY_ATS` (`packages/domain`) gains `smartrecruiters`; the `apply_submission` ATS CHECK is
   widened by a migration (expand only: every existing row still passes).
2. `packages/gateways/src/apply/adapters/smartrecruiters.ts`, on the `AtsAdapter` contract like
   NS-120's adapters:
   - host `jobs.smartrecruiters.com` only; a `careers.` link is refused until it is rewritten to
     it (as `boards/detect.ts` does);
   - the posting id is the numeric id in `/<Company>/<id>[-slug]`, as `detectAts` reads it;
   - standard fields `firstName`, `lastName`, `email`, `phoneNumber` (only when given), the resume
     upload `resume`, the cover letter `coverLetter`;
   - a confirmation is the `/success` page **and** "thank you for applying" (the text alone could
     come from a job description on a re-rendered form page);
   Field names and markers are **hand-written synthetic**, marked as such, like NS-120's; real
   recordings are NS-142's job.
3. Fixtures for it in `test/fixtures.ts`, so every shared adapter test (`describe.each(APPLY_ATS)`)
   runs on it, plus its own mapping tests.

### Slice 2: liveness checks (next PR)
Re-check a queued job's posting through `safeFetch` and the boards' public APIs only, telling a
closed posting (404, or absent from its board) from an unavailable board; store the result and
mark closed jobs; the Apply Gateway refuses a closed posting. Its own spec section lands with it.

## Acceptance criteria (slice 1)
- [ ] Every shared adapter test passes for `smartrecruiters`.
- [ ] A SmartRecruiters apply URL on another host (including `careers.`) is `HostNotAllowed`; a
      posting id that doesn't match the URL's is `PostingMismatch` (`submit.test.ts`).
- [ ] The database accepts a `smartrecruiters` submission and still refuses an unknown ATS.

## Failure modes
As NS-120: anything the adapter can't map is `form_changed` or `unmapped_required`
(`needs_human`); nothing is submitted until the Playwright driver lands (NS-142).

## Out of scope
- Real recorded SmartRecruiters pages (NS-142).
- Slice 2 (above).

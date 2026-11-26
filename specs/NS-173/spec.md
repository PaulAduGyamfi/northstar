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

### Slice 2: liveness checks (second PR)
1. `checkPosting(deps, url)` (`packages/sources/src/liveness.ts`): one request through `safeFetch`
   to the posting's ATS API, from the job source's URL (`detectAts`):
   - Greenhouse, Lever, SmartRecruiters single-posting endpoints: 200 open, 404 closed;
   - Ashby: the board; a posting absent from a board that answered is closed;
   - anything else (a refused fetch, a 5xx, a malformed answer, an Ashby board that's gone, an
     ATS with no posting API) is `unavailable` and never closes a job.
2. `checkPass`: the jobs due (ready, with a checkable ATS source, not closed, not checked in the
   last 24 h; never-checked first; at most 50 a pass), each behind its `source:<ats>` kill switch
   and breaker (NS-147). A 404 is the ATS answering; a 5xx counts against its breaker.
3. `posting_check` (`packages/db`, append-only): one row per answered check. A job that turns
   closed gets one `job.closed` event (job id and ATS only). `readScorableJobs` leaves closed jobs
   out of the queue.
4. CLI `jobs check`: one pass, counts only.

Not in slice 2 (follow-up issue): moving applications that reference a closed job, and the Apply
Gateway refusing a closed posting; both belong with package assembly (NS-161).

### Acceptance criteria (slice 2)
- [ ] A posting the ATS still serves is open; a 404 (or absent from an answering Ashby board) is
      closed; a 5xx, a gone board or an unknown link is unavailable and stores nothing.
- [ ] A job checked in the last day, a closed job and a job without a checkable ATS aren't due.
- [ ] A job turning closed writes one `job.closed` event; it leaves scoring.
- [ ] A held-back ATS makes no request.

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

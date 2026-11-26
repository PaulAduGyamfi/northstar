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
   - Ashby: the board (board byte cap, read once per org per pass); a posting absent from a board
     that answered is closed;
   - anything else (a refused fetch, a 5xx, a malformed answer, an Ashby board that's gone) is
     `unavailable`. EU Lever links (`jobs.eu.lever.co`, served from `api.eu.lever.co`, not on the
     allowlist) aren't checked: the US API would answer 404.
2. `checkPass`: the jobs due are ready jobs whose source the ATS's API served (`method = ats_api`:
   an unlisted Ashby posting read from its page is never on the board, so "absent" would mean
   nothing), not tried in the last 24 h (closed ones: 7 days, so a wrong closure comes back);
   never-tried first; at most 50 a pass. Each is behind its `source:<ats>` kill switch and breaker
   (NS-147); only a 5xx, 429 or failed fetch counts against the breaker (a 404 is an answer). A link
   with no API to ask touches no breaker.
3. `posting_check` (`packages/db`, append-only): one row per attempt, `unavailable` included, so a
   dead link drops back in line instead of taking every pass. A job is closed only after **two
   closed answers in a row** (unavailable attempts skipped): one mistaken 404 never closes it. It
   then gets one `job.closed` event and leaves scoring (`readScorableJobs`); a closed job that
   answers open again gets `job.reopened`. Events carry the job id and ATS only.
4. CLI `jobs check`: one pass, counts only.

Not in slice 2 (#209): moving applications that reference a closed job, the Apply Gateway refusing
a closed posting, and a closed marker in `jobs list`; they belong with package assembly (NS-161).

### Acceptance criteria (slice 2)
- [ ] A posting the ATS still serves is open; a 404 (or absent from an answering Ashby board) is
      closed; a 5xx, a gone board or an unknown link is unavailable.
- [ ] A job closes after two closed answers in a row, not one; it leaves scoring, and comes back
      when a weekly re-check finds it open.
- [ ] Only API-served sources are due; never-tried first; a job tried in the last day isn't due.
- [ ] A held-back ATS (switch or breaker) makes no request; a 404 isn't a breaker failure.

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

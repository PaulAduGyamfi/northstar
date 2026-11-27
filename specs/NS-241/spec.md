# NS-241: Proposed prep blocks for a confirmed interview (slice 1: storage)

Status: draft
Requirements: CAL-003 (default prep before an interview), CAL-002 (confirmed interviews)
Rules that apply: ADR-0002 (nothing is written to the calendar here), ADR-0012 (append-only),
ADR-0016 (autonomous lane; waiver on #275 for this slice), ADR-0026, `.claude/rules/db.md`,
`.claude/rules/tests.md`

## Why
Paul confirms a detected interview on `/interviews` (NS-240). The next step is the prep: CAL-003
wants two 45-minute blocks in the three days before and a 15-minute warm-up an hour before.
`planPrepBlocks` (NS-170 slice 1) works the times out but nothing keeps them, so no approval card
or calendar write can follow. This slice stores one proposal per confirmed interview.

## Behavior
- `proposeInterviewPrep(db, { candidateId, detectionId, request })`, where `request` is
  `{ busy, workingHours, timeZone, now }`, checked by `PrepRequest` (`packages/db`,
  `interview-prep-write.ts`):
  - checks, in one transaction under the candidate's lock, that the detection is the candidate's
    own, is still current (no newer version for its event and application) and that Paul
    confirmed it;
  - runs `planPrepBlocks` over the stored interview's start and end and the caller's busy time,
    working hours, time zone and now (code decides the times, never the caller);
  - stores one `interview_prep_proposal` per detection (with the plan's `missingPrep` and
    `warmUpMissing`) and its blocks in `interview_prep_block` (kind `prep` or `warm_up`, start,
    end), append-only;
  - writes one `interview.prep_proposed` event on the application, with ids and counts only; its
    feed line is a fixed-word `reason` ("Proposed 2 prep blocks and a warm-up for your
    interview");
  - a second call for the same detection stores nothing and returns the first proposal
    (`recorded: false`): the plan is not worked out again.
- Refusals: `UnknownDetection`, `Superseded`, `NotConfirmed` (no decision yet, or dismissed),
  `InterviewStarted` (the caller's `now` is at or after the interview's start: an empty plan stored
  once could never be redone),
  `InvalidInput` (bad working hours, unknown time zone or invalid dates; field names only).
- `readPrepProposal(db, candidateId, detectionId)` gives the stored proposal and its blocks, or
  null.

## Acceptance criteria
- [ ] A confirmed, current detection stores one proposal with the planner's blocks and one event.
- [ ] Calling it twice stores one proposal and one event; the second answer is `recorded: false`.
- [ ] An undecided or dismissed detection is `NotConfirmed`; a replaced version is `Superseded`;
      another candidate's or an unknown id is `UnknownDetection`. None stores anything.
- [ ] Bad working hours or an unknown time zone are `InvalidInput`, storing nothing.
- [ ] The tables refuse UPDATE, DELETE and TRUNCATE, and their grants pass `app-role.test.ts`.
- [ ] A block's CHECKs: end after start, kind listed; one proposal per detection.
- [ ] The event carries no time zone, title, address or name.
- [ ] `pnpm turbo run lint typecheck test --filter=@northstar/db` passes.

## Failure modes
- The database is down: the call throws and nothing is stored; the caller retries (same result,
  one row, by the unique detection id).
- Two callers race: the candidate lock and the unique constraint keep one proposal.
- The caller's clock is wrong (after the interview): refused as `InterviewStarted`, nothing stored.
- Busy time is wrong or missing: the plan may overlap real events. It is only a proposal; nothing
  reaches the calendar without Paul's approval (a later slice).

## Observability
- Event `interview.prep_proposed` (actor `system`): `applicationId`, `detectionId`, `proposalId`,
  `prepBlocks`, `missingPrep`, `warmUp` (boolean). Feed line from its fixed `reason`.
- Span `db.interview.prep_propose` with the block and missing counts.

## Out of scope
- Reading busy time from Calendar and growth blocks, and calling this on confirm (the caller).
- The approval card, calendar writes, reminders (CAL-004), working-hours settings, briefs,
  practice and reviews (CAL-005…007).
- Changing the defaults or prep on the interview's morning.

## Open questions
- None for this slice: the waiver on #275 (orchestrator comment) fixes its scope.

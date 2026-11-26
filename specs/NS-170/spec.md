# NS-170: Interview prep (slice 1: prep-block plan and reminder times)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: CAL-003, CAL-004 (the plain-code plan only) · ADR-0002, ADR-0026.
GitHub issue #121. Blocker #120 (NS-169) is closed.
Rules that apply: `.claude/rules/tests.md`.

## Why
CAL-003 asks Northstar to propose prep sessions before each interview, in Paul's free time and
working hours, for him to approve once per interview. CAL-004 asks for reminders the day before
and the hour before. This slice is the plain-code planner both need. It proposes and never writes:
writing to the calendar goes through the Gate later.

## Behavior
1. **`planPrepBlocks(input)`** (`packages/domain`, `interview-prep.ts`, plain code). It takes:
   - the interview's start and end;
   - Paul's busy intervals;
   - his working hours (local minutes from midnight, start before end);
   - an IANA time zone;
   - the current time.

   It returns a proposal:
   - **Prep blocks:** two of 45 minutes each (CAL-003's default), in the 3 days before the
     interview. Each block lies inside working hours in the given zone, in free time, after now,
     and ends at least 1 hour before the interview.
     - They are spread one per local day where possible, the days nearest the interview first,
       and placed at the earliest free start on a 15-minute grid.
     - Then a second block on the same day, if days ran out.
   - **Warm-up:** 15 minutes, from 1 hour to 45 minutes before the interview. Kept only if that
     time is free and after now; working hours don't apply.
   - No two blocks overlap each other, the interview or any busy time.
   - **What couldn't be placed** is reported (`missingPrep` as a count, `warmUpMissing`). Nothing
     is ever shortened or forced.
2. **`reminderTimes(interviewStart, now)`** (CAL-004): the day-before reminder (24 hours before)
   and the hour-before reminder. A time already past is dropped.
3. **Times are checked one by one in the time zone** through `Intl`, so a daylight-saving shift
   moves working hours with the clock.

## Acceptance criteria
- [ ] With an empty calendar, two blocks land on the two nearest days (the interview's own day
      and the day before), at the start of working hours, and the warm-up an hour before.
- [ ] A busy morning pushes a block to the first free 15-minute start after it.
- [ ] A fully busy day moves its block to another day. With every day busy, `missingPrep: 2`.
- [ ] Blocks respect the time zone. For example, 09:00 in Toronto is 14:00 UTC in winter.
- [ ] A busy warm-up time gives `warmUpMissing: true`. A block never overlaps the interview.
- [ ] Nothing is planned before `now`, so an interview tomorrow gets only the blocks still ahead.
- [ ] `reminderTimes` gives both times, or drops the one already past.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **An unknown time zone or bad working hours** (start not before end, outside 0–1440): it throws
  a plain error, because that is the caller's bug.

## Observability
None: pure functions with no caller. The caller (a later slice) emits `interview.prep_proposed`.

## Out of scope
- **Writing blocks to the calendar.** That needs `calendar.app.created` or `calendar.events` and
  a Gate approval per write (ADR-0002, ADR-0026).
- Reading free/busy, which is #271's client. Storage, the approval card and sending reminders.
- Briefs, practice and reviews (CAL-005…007).
- Respecting the growth plan's blocks (CAL-003): the caller adds them as busy time.

## Decisions (ADR-0016)
- **The planner lives in `packages/domain`**, as pure code like the growth planner.
- **"The 3 days before" is the 72 hours before the interview's start**, so the interview's own
  morning is the nearest day. The first acceptance criterion was worded to match after the build.

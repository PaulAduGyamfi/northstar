# NS-241 slice 7: plan prep around Paul's own calendar, on request

Issue: #275 · Requirements: CAL-003 · ADRs: ADR-0026, ADR-0014, ADR-0031 · Decided on #400

## Why
Since slice 6, `funnel prep` plans around what Northstar has stored: Paul's other interviews and
the prep blocks already planned. It can't see his other meetings, so a prep block can land on one.
On #400 Paul decided Google consent is asked per run with no stored token. A second read-only
consent in the same run fits that decision, but only when he asks for it.

## What changes
1. **The flag.** `funnel prep --busy-from-calendar` is opt-in. Without it the run is exactly as
   today: one consent, and only when an approved plan waits to be written.
2. **Consent only when there's something to plan.** With the flag, and only when at least one
   confirmed, upcoming interview has no stored proposal, the run:
   - asks `authorizeCalendar` (`calendar.events.readonly` alone, its own consent; the token stays
     in that call's closure for the run and is never stored, ADR-0026);
   - reads the primary calendar's events once, through the stored `calendar` breaker
     (`createCalendarClient(...).listEvents`), from now to the latest such interview's start, at
     most 60 days (the client's own limit);
   - keeps each event's start and end only. A cancelled event is dropped. Titles, descriptions,
     organizers, attendees and ids are never kept, printed or stored.
3. **Merged busy time.** The calendar's intervals join the stored ones in `busyFor`, still at most
   500, soonest first. Each plan gets only the calendar events that overlap its own prep days
   (`calendarNear`: `PREP_DAYS` plus a day of slack before the interview, up to its start), so a
   calendar with hundreds of meetings can't crowd out the ones that matter. The interview's own
   calendar event may be among them, which is harmless: the planner keeps its time free anyway.
4. **Fail small.** A refused or failed consent, or a failed read, never stops the run. The run
   plans with stored busy time only and prints one line that says so, naming the error's class only
   (never its message). On success it prints how many calendar events it planned around.
5. **Docs.** The AGENTS.md command row and layout note, the README and `.claude/rules/gateways.md`.

## Out of scope
- A stored or refresh token, or reading the calendar on a schedule (ADR-0026: Paul's decision).
- Free/busy (`freeBusy.query`) or other calendars: the client reads only the primary calendar's
  `events.list`, with fields limited, and ADR-0026 covers exactly that.
- Treating an event marked "free" as not busy: `transparency` isn't in the client's fields.
- All-day events (a vacation day): the read-only client skips them, as detection needs a time.
- An interview more than about 60 days out gets no calendar time (the client's 60-day window).
  Its plan is made once, without calendar time, and isn't redone later; Paul sees its blocks in
  the Queue before approving.

## Decisions made without Paul
- **Opt-in flag, default off,** so the usual run asks for at most one consent page.
- **Consent only when a plan is about to be made.** A run with nothing to plan asks nothing, as
  slice 5 does for the writer.

## Acceptance criteria
- [ ] Without the flag, `runPrep` never asks for the calendar.
- [ ] With the flag, it asks only when something will be planned, with the right window. It merges
      the events' times into the busy time each plan gets, and reports the count.
- [ ] A failing calendar read (consent or Google) is reported, and planning goes on with stored
      busy time.
- [ ] `prepCommand` prints the calendar line in both cases, and only when the flag was given.
- [ ] `funnel prep --busy-from-calendar` passes the flag, and any other argument is refused.
- [ ] No migration.

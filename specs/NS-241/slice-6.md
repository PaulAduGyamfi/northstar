# NS-241 slice 6: see a prep plan in the Queue, and plan around stored busy time

Issue: #275 · Requirements: CAL-003, CAL-004, UX-014 · ADRs: ADR-0031, ADR-0002, ADR-0018

## Why
Slice 5 (#433) lets `funnel prep` file prep plans with the Gate and write the approved ones. Two
gaps remain on #275:
- **The Queue card shows nothing to approve.** It lists a `prep_plan` request by kind and subject
  only. The block times print in Paul's terminal on the run that filed them, and nowhere after.
- **The planner sees no busy time.** Two interviews' prep blocks can land on each other, or on the
  other interview.

## What changes
1. **Read (`apps/api`).** `GET /approvals/prep-plan?requestId=<uuid>`, session only, in its own
   file (`prep-plan-view.ts`). It answers the stored plan behind a `prep_plan` request:
   - the interview's start and end (the detection the plan was filed for);
   - each block's kind (`prep` or `warm_up`), start and end;
   - `rescheduled`: true when the interview's current version isn't the one the plan was filed
     for (the writer would withdraw it).

   The data comes from `readPrepPlan` and `listInterviews` (`packages/db`), copied field by field.
   It never returns an event id, title, address, calendar id or hash. An unknown request, another
   candidate's or a non-plan request is a 404 `not_found`.
2. **Queue (`apps/web`).** A `prep_plan` item gets a "Show the plan" button:
   - `PrepPlanPreview` (`app/approvals/prep-plan-preview.tsx`) fetches the plan only when Paul
     asks.
   - `prepPlanLines` (`src/prep-plan.ts`) words it as plain text in the browser's own time zone:
     the interview's day and time, then each block's day, start and end, in time order.
   - A rescheduled plan says "The interview moved after this plan was made: reject it, and the
     next `funnel prep` plans for the new time."
   - `approval-queue.tsx` gains one line that renders it, beside the reply preview (agent 1's #179
     also touches this file).
3. **Busy time (`packages/funnel`).** `runPrep` passes the planner Paul's busy time from what is
   already stored:
   - every other interview that isn't dismissed (start to end);
   - the blocks of every stored proposal, including ones planned earlier in the same run.

   It stays within `PrepRequest`'s 500-interval bound (the newest 500 if there were ever more).
   It needs no new consent, no stored token and no Calendar read. Events on Paul's own calendar
   that Northstar didn't detect are still unknown to the planner.

## Out of scope
- **Reading Paul's whole calendar for busy time.** That needs a second, read-only consent in the
  same run (or a stored token, Paul's call under ADR-0026).
- **Editing a plan in the Queue.**
- **Showing the plan on Today.**

## Decisions made without Paul
- **Busy time from stored data only**, not a second consent: one consent page per run is the rule
  #400 set.
- **Times in the browser's zone**, not `PREP_TIME_ZONE`: the web app doesn't read the funnel's
  settings, and Paul's browser is in his zone.

## Acceptance criteria
- [ ] The API answers a stored plan field by field, with `rescheduled` set from the current
      detection version; an unknown or another candidate's request is 404.
- [ ] `prepPlanLines` gives the interview line and one line per block, in time order, in the
      given zone, plus the rescheduled line when set.
- [ ] `runPrep` passes the other interviews and the stored proposals' blocks as busy time, never
      the interview being planned or a dismissed one, at most 500 intervals.
- [ ] AGENTS.md, the rules docs and the README say what changed.

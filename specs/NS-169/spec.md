# NS-169: Calendar and interview detection (slice 1: the scope decision and plain-code detection)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: CAL-001 (the read scope only), CAL-002 · ADR-0002, ADR-0014.
GitHub issue #120. The scope decision is the comment on #120 of 2026-11-26.
Rules that apply: `.claude/rules/tests.md`.

## Why
Interviews are the point of the search, and CAL-002 asks Northstar to notice them, from email
and from calendar invites, and to attach each one to its application with its stage, format and
interviewers. This slice records the Calendar scope decision and builds the detection as plain
code, so the Calendar client and storage can follow on a tested core.

## Behavior
1. **ADR-0026 (Proposed): Google Calendar read-only.**
   - The scope is `calendar.readonly`, under ADR-0014's token model: desktop OAuth with PKCE, an
     in-memory token for one run, never stored.
   - Writes (prep blocks, CAL-003) are deferred. Each will need `calendar.events` and a Gate
     approval (ADR-0002).
   - Paul enables the Calendar API and adds the scope to his OAuth client himself.
2. **`detectInterview(event, candidates)`** (`packages/inbox`, `src/interview/detect.ts`, plain
   code). It takes one calendar event (title, description, start, end, status, organizer and
   attendee addresses) and the open applications' company domains and active windows.
   - **Cancelled events** → `none` (`cancelled`).
   - **Not an interview** → `none` (`not_interview`), unless the title names one: interview,
     phone screen, screening call, recruiter call, technical, coding, pairing, system design,
     behavioral, onsite, final round, panel, or hiring manager.
   - **Picking the application.** It picks exactly one by the organizer's and attendees' address
     domains, under the application's own company domains, inside its active window.
     - Shared ATS and freemail domains never pick one, the same list `matchMail` uses.
     - No match → `none` (`no_match`). Several → `ambiguous`, with the candidates.
   - **Result.** An `interview` with the application, start, end, format and the interviewers
     (attendee addresses under the matched company's domains).
     - Format comes from fixed words, in this order: `system_design`, `behavioral`, `technical`,
       `onsite`, `phone_screen`, otherwise `other`.
     - `confirmed: false` is always set: a calendar invite isn't authenticated, so the result is
       a proposal for Paul to confirm and never changes a status.
3. **`interviewFromMail(kind, link)`** (plain code). A linked `interview_request` or `scheduling`
   message gives `to_schedule` for its application. Anything else gives `none`.

## Acceptance criteria
- [ ] `detectInterview`:
  - an invite titled "Technical interview" from the company's domain links to its application
    with format `technical` and the company's attendees as interviewers;
  - a cancelled event, a lunch and an unmatched domain give `none` with their reasons;
  - two applications at the same company give `ambiguous`;
  - an organizer on a shared ATS or freemail domain never picks;
  - an event outside the active window doesn't match;
  - each format word maps to its format;
  - every result is `confirmed: false`.
- [ ] `interviewFromMail`: `interview_request` and `scheduling` on a linked message give
      `to_schedule`; a queued link or another kind gives `none`.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **A forged invite** (an organizer address claiming the company's domain): calendar
  invites carry no authentication Northstar can read here, so a detection is only ever a
  proposal (`confirmed: false`). Paul confirms it, and no status moves.

## Observability
None yet: nothing stores or emits a detection. The caller (slice 2) emits `interview.detected`.

## Out of scope
- **The Calendar client** (`events.list` through a `calendar` breaker), storing interviews, the
  confirm step, and the Today card. These are slice 2.
- **Calendar writes and prep blocks** (CAL-003). They need `calendar.events` and the Gate.
- Reminders, briefs, practice and reviews (CAL-004…008, #121).

## Decisions (ADR-0016)
- **The detection lives in `packages/inbox`,** next to `matchMail`, whose shared-domain rule it
  reuses. No new package.
- **The Calendar client is deferred to slice 2,** so this slice stays a tested plain-code core.

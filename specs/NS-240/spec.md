# NS-240: The read-only Calendar client (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: CAL-001 (read), CAL-002 · ADR-0026 (Proposed), ADR-0014, ADR-0007
Rules that apply: `.claude/rules/tests.md`. Issue #271 (Parent: #120).

## Why
NS-169 built `detectInterview`, which turns one calendar event into a proposed interview, but
nothing can read Paul's calendar. This slice adds the reader ADR-0026 describes. Nothing reads
his real calendar until Paul accepts the ADR, enables the API and adds the scope to the consent
screen: no scope request or OAuth wiring is added here.

## Behavior
- **`CalendarAccess`** (`packages/inbox/src/calendar/access.ts`) is the Calendar token's own type.
  It has a private field of its own, so TypeScript won't let a `GmailAccess` or `GmailLabelAccess`
  stand in for it (and the other way round). It prints a mask, never the token.
- **`createCalendarClient(deps)`** (`calendar/client.ts`) has one method:
  `listEvents({ timeMin, timeMax })`. It calls only
  `GET https://www.googleapis.com/calendar/v3/calendars/primary/events` with:
  - `timeMin`, `timeMax`, `singleEvents=true`, `orderBy=startTime`, `maxResults=250`;
  - `fields=` limited to the next page token and each item's id, summary, start, end, status,
    organizer email and attendee emails. Descriptions, locations and conference links are never
    fetched (ADR-0026 item 3).

  It follows every page.
- **What it returns.** Each item becomes `detectInterview`'s `CalendarEvent`:
  - `description` is always null;
  - all-day events (a `date`, no `dateTime`) are skipped, since an interview has a time;
  - an item with a missing id, time or status is skipped, never guessed;
  - the window is refused if `timeMin` isn't before `timeMax` or it spans more than 60 days.
- **Through the `calendar` breaker** (NS-174's `CallGuard`):
  - a held-back read throws `HeldBack` and sends nothing;
  - 429, 5xx, rate-limit 403s and dropped connections are retried with backoff, as the Gmail
    client does, and only those count against the breaker;
  - a 401, 404 or other 4xx is Calendar answering.
- **Errors and spans** carry statuses, counts and Google's reason code only: never a title, an
  address or the token.
- **A boundary test** (`calendar/boundary.test.ts`) scans `src/calendar/` and fails on:
  - any write method;
  - any other Calendar endpoint (`/calendarList`, `/acl`, `/settings`, `freeBusy`, `watch`, …);
  - any calendar but `primary`;
  - a `description` or `location` field in the request.

## Acceptance criteria
- [ ] `listEvents` sends one GET per page to the primary calendar's events with exactly those query
      parameters and `fields`, and the Calendar token's authorization (a fake fetch).
- [ ] It follows `nextPageToken`, skips all-day and incomplete items, and maps the rest to
      `CalendarEvent`, which `detectInterview` accepts.
- [ ] A held-back read sends nothing. A 503 that outlasts the retries counts against the breaker; a
      404 doesn't.
- [ ] A bad window is refused before any request.
- [ ] `CalendarAccess` and `GmailAccess` can't stand in for each other (a type test), and the token
      prints masked.
- [ ] The boundary scan passes, and catches a forbidden call if one is added.
- [ ] AGENTS.md says the client exists and what still waits on Paul.

## Out of scope
- The OAuth consent flow for `calendar.events.readonly`, which waits on Paul accepting ADR-0026.
- Storage of detections and the confirm step (#271 items 2–3, which need `packages/db`).
- Free/busy time and any write (CAL-001 later, CAL-003).

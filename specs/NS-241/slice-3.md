# NS-241 slice 3: the Calendar Gateway's write module (no Gate wiring yet)

Status: in review (PR)
Requirements: CAL-001 (a dedicated Northstar calendar), CAL-003 (prep blocks)
Rules that apply: ADR-0031 (Accepted), ADR-0002, ADR-0014, ADR-0025 (the model), ADR-0026,
ADR-0007, `.claude/rules/gateways.md`, `.claude/rules/tests.md`

## Why
ADR-0031 decides how approved prep blocks reach Google Calendar. This slice builds the parts that
need no database: the write token, its consent flow and the only requests the writer may send.
The Gate wiring (`verifyApproval`, the ledger, the `prep_plan` entry point) needs a migration and
comes next.

## Behavior
`packages/gateways/src/calendar/`:
- `access.ts`: `CALENDAR_APP_CREATED_SCOPE` and `CalendarWriteAccess`, a token type of its own
  (private brand, prints a mask, no public accessor). Only `requests.ts` reads it back
  (`calendarBearer`).
- `consent.ts`: `authorizeCalendarWrite`, desktop OAuth with PKCE to a one-shot `127.0.0.1`
  listener, `access_type=online`, scope `calendar.app.created` only. Scopes come from Google's
  answer; any other granted scope is refused (`CalendarConsentError`), and a grant without it
  gives a token whose `hasWriteScope()` is false. The token exchange stays inside the module.
- `requests.ts`: `requestAllowed` and `createCalendarWriteClient` with three calls:
  - `createCalendar()`: `calendars.insert` with the fixed name "Northstar" and the fixed marker
    description; returns the calendar id.
  - `findMarkedCalendar()`: `calendarList.list` (fields limited), the id of the calendar carrying
    the marker, or null.
  - `insertPrepEvent(calendarId, event)`: `events.insert?sendUpdates=none` with a body of exactly
    `id`, `summary`, `start.dateTime`, `end.dateTime` (UTC). The summary is the fixed title for
    the block's kind; the id must be lowercase base32hex, 5–1024 characters. 201 is `created`,
    409 is `exists`.
  Each request passes the allowlist, the `calendar_writes` kill switch and the `calendar` breaker
  (only no answer, 429 and 5xx count against it). Errors name a status and Google's reason code,
  never a token, id or body.
- `errors.ts`: the guard port and the errors the package exports.
- `boundary.test.ts`: only `src/calendar/` imports `requests.ts`, `access.ts` or `consent.ts` (the
  package entry may export the token type and the consent entry point); nothing under it names an
  update, patch, move, delete, `attendees`, `conferenceData`, `location`, `reminders` or a fetch
  port; only `requests.ts` reads the token back; the package entry never exports the test seam.

## Acceptance criteria
- [x] The allowlist accepts the three requests and refuses an update, delete, move, another
      calendar list query, an event body with any other key, `sendUpdates=all`, a lookalike host.
- [x] `insertPrepEvent` sends exactly the allowed body; 409 answers `exists`; a held-back request
      never reaches `fetch`.
- [x] The consent flow refuses a wider grant and never quotes the token in an error.
- [x] The token prints a mask and has no accessor.
- [x] The boundary tests pass.
- [x] `pnpm --filter @northstar/gateways lint typecheck test` pass.

## Out of scope
The Gate check, the ledger, the calendar id's storage, the `prep_plan` entry point, the dead-letter
kind, the command that runs it (next slice, with the migration).

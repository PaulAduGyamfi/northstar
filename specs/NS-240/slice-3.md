# NS-240 slice 3: the Calendar consent flow

Status: in progress (autonomous lane, ADR-0016)
Requirements: CAL-001, CAL-002, NFR-SEC-002 · ADR-0026 (Accepted) items 1, 2 and 7 · ADR-0014
Rules that apply: `.claude/rules/inbox.md`, `.claude/rules/tests.md`, AGENTS.md "Secrets".
Issue #271. Slices 1–2: #305, #320.

## Why
The Calendar client (slice 1) reads with a `CalendarAccess`, but nothing can make one: there is no
consent flow. ADR-0026 is accepted: `calendar.events.readonly`, on its own consent and token,
under ADR-0014's model (desktop OAuth with PKCE, a loopback redirect, the token in memory for one
run, no refresh token).

## Behavior
- `authorizeCalendar(deps)` (`packages/inbox`, `oauth.ts`) runs the same flow as
  `authorizeGmail`: PKCE S256, a random `state`, a one-shot listener on `127.0.0.1` (port 0),
  `access_type=online`, one callback, then the listener stops.
- It requests `https://www.googleapis.com/auth/calendar.events.readonly` only, never with a Gmail
  scope.
- **The grant decides.** The scopes come from Google's token response. A grant of anything but
  exactly `calendar.events.readonly` (a Gmail scope, `calendar.readonly`, `calendar`, or several)
  is refused with `OAuthError`, so a Calendar token can never read mail or write events.
- It returns a `CalendarAccess`. `authorizeGmail` is unchanged and keeps its own scope check.
- Both share one private flow, which never returns a raw token outside `oauth.ts`.
- No token, code or verifier in an error, log or span. The tab says "Northstar is connected to
  Google Calendar (read only)".
- No caller yet: the detection run that uses it (and turns `TooManyChanges` and `DailyLimit` into
  dead letters) is a later slice. Paul enables the Calendar API and adds the scope to the consent
  screen himself (ADR-0026 item 7).

## Acceptance criteria
- [ ] The consent URL asks for `calendar.events.readonly` only, with PKCE S256, `access_type=online`
  and a `127.0.0.1` redirect.
- [ ] A grant of exactly that scope returns a `CalendarAccess` that never prints its token.
- [ ] A grant with a Gmail scope, a wider Calendar scope, several scopes or none is refused.
- [ ] A forged `state`, a cancelled consent and a timeout are refused, as for Gmail.
- [ ] Every existing `authorizeGmail` test still passes unchanged.
- [ ] `pnpm turbo run lint typecheck test build` passes in `packages/inbox`.

## Out of scope
- The detection caller, the API and the page; free/busy (`calendar.freebusy`) and writes.

# ADR-0026 — Google Calendar read-only first, with an in-memory token; writes later through the Gate

**Status:** Proposed · **Date:** 2026-11-26

## Context
CAL-001 asks Northstar to connect Google Calendar, read free and busy time, and create events on
a dedicated "Northstar" calendar. CAL-002 asks it to detect interviews from email and calendar
invites. ADR-0014 gives Northstar Gmail read-only, with the access token in memory for one run
and never stored, and it covers no Calendar scope.

NS-169 (#120) asked Paul to decide the Calendar scope and token model in an ADR. An agent decided
it on 2026-11-26 under his delegation ("Anything needed from my use your recommended choice"),
and this ADR records that decision.

## Decision
1. Detection comes first, with `https://www.googleapis.com/auth/calendar.readonly`. It reads
   events and free/busy time and cannot change anything.
2. The token model stays ADR-0014's:
   - desktop OAuth with PKCE and a loopback redirect;
   - the access token in memory for one run;
   - no refresh token stored;
   - nothing written to disk, the database, logs, events or spans.
3. The Calendar client reads with plain `fetch` against the REST API (`events.list`, and later
   `freeBusy.query`), with no Google SDK. Every read goes through a `calendar` breaker, like Gmail
   (NS-174).
4. A calendar invite carries no authentication Northstar can check, so an interview detected
   from one is a proposal Paul confirms. It never moves an application's status by itself.
5. Writes are deferred. Prep blocks (CAL-003) and a dedicated calendar each need
   `calendar.events` and a Gate approval (ADR-0002) per write, and get their own decision then.
6. Paul enables the Calendar API and adds the scope to the Google OAuth client himself.

## Alternatives considered
- **`calendar.events` now.** This would allow writes before the Gate path for them exists, and
  detection doesn't need it.
- **Detect from email only.** Many interviews arrive as calendar invites from an ATS's scheduler
  with little in the email, so CAL-002 needs the calendar.
- **Store a refresh token.** This would build half the vault's work for a read that runs when
  Paul starts it, as ADR-0014 argued for Gmail.

## Consequences
- + The reader can't change Paul's calendar, whatever a bug or an injected invite tries.
- + Detection is plain code over events, testable without Google.
- − Paul consents on each run that reads the calendar, as with Gmail.
- − A forged invite can look like an interview, so every detection waits for Paul's confirm.
- NS-169 slice 1 adds only the detection. The client, storage and the confirm step come next.

# ADR-0026 — Google Calendar read-only first, with an in-memory token; writes later through the Gate

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

## Context
CAL-001 asks Northstar to connect Google Calendar, read free and busy time, and create events on
a dedicated "Northstar" calendar. CAL-002 asks it to detect interviews from email and calendar
invites. ADR-0014 gives Northstar Gmail read-only, with the access token in memory for one run
and never stored, and it covers no Calendar scope.

NS-169 (#120) asked Paul to decide the Calendar scope and token model in an ADR. An agent decided
it on 2026-11-26 under his delegation ("Anything needed from my use your recommended choice"),
and this ADR records that decision.

## Decision
1. Detection comes first, with `https://www.googleapis.com/auth/calendar.events.readonly`. It
   reads events and nothing else: not calendar settings, ACLs or anything writable.
   - This is narrower than the `calendar.readonly` the delegated decision named. Detection needs
     events only, and least privilege (NFR-SEC-002) favors the narrower scope.
   - Free/busy time (CAL-001, later) needs `calendar.freebusy` on its own consent when it comes.
2. The token model stays ADR-0014's:
   - desktop OAuth with PKCE and a loopback redirect;
   - the access token in memory for one run;
   - no refresh token stored;
   - nothing written to disk, the database, logs, events or spans.

   The Calendar scope is requested on its own consent and token, never combined with or added
   to the Gmail token, so each token carries one scope.
3. The Calendar client reads with plain `fetch` against the REST API, with no Google SDK:
   - only `events.list` on the primary calendar, with a `timeMin`/`timeMax` window;
   - `fields=` limited to id, summary, start, end, status, organizer email and attendee emails,
     so descriptions, locations and conference links are never fetched;
   - every read goes through a `calendar` breaker, like Gmail (NS-174).
4. An invite's title, organizer and attendees are whatever its author typed: claims, not
   evidence. Northstar reads no authentication for them, so:
   - an interview detected from an invite is a proposal Paul confirms, shown with its organizer
     and "not verified";
   - a detection never moves an application's status by itself;
   - if a confirmation should ever carry weight, it must rest on the invitation email's
     DMARC/DKIM result (`matchMail`'s `senderVerified`).
5. Event text is untrusted (NFR-SEC-004). Any later model route over it puts the text in an
   `untrustedBlock` and holds no side-effect tools.
6. Writes are deferred. Prep blocks (CAL-003) and a dedicated "Northstar" calendar get their own
   decision. The leading option is `calendar.app.created`, which can only touch calendars the app
   created, with a Gate approval (ADR-0002) per write.
7. Paul enables the Calendar API and adds the scope to the OAuth consent screen himself. The
   Calendar scopes are "sensitive" in Google's terms.

## Alternatives considered
- **`calendar.readonly`.** It also reads calendar settings, ACLs and the calendar list, which
  detection doesn't need.
- **`calendar.events` now.** This would allow writes before the Gate path for them exists, and it
  can edit every event. For writes later, `calendar.app.created` is the narrower choice.
- **Detect from email only.** Many interviews arrive as calendar invites from an ATS's scheduler
  with little in the email, so CAL-002 needs the calendar.
- **Store a refresh token.** This would build half the vault's work for a read that runs when
  Paul starts it, as ADR-0014 argued for Gmail.

## Consequences
- + The reader can't change Paul's calendar, whatever a bug or an injected invite tries.
- + Detection is plain code over events, testable without Google.
- − Paul consents on each run that reads the calendar, separately from Gmail's consent.
- − Continuous detection (the InterviewWorkflow, `system-design.md`) needs a stored refresh token.
  That waits for the vault and a superseding ADR, as ADR-0014 says for Gmail.
- − A forged invite (any organizer or attendee address) can look like an interview, so every
  detection waits for Paul's confirm.
- NS-169 slice 1 adds only the detection. The client, storage and the confirm step come next.

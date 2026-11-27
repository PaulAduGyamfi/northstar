# ADR-0029 — The extension may read one open handoff's approved package

**Status:** Accepted, option 2 (Paul, by delegation to the orchestrator on 2026-11-27) ·
**Date:** 2026-11-26 · **Amends:** ADR-0019's "no reads" consequence, only for the 2 minutes after
Paul's own click

> **Accepted: option 2, a one-time grant from Paul's session.** A leaked extension token alone
> still reads nothing. Options 1 and 3 are not chosen.

## Context
APPLY-006 and ACC-007 ask that, when a CAPTCHA, sign-in or verification step stops a submission,
the "Save to Northstar" extension fill that form in Paul's own tab with what he already approved.
It never submits and never touches the challenge (ADR-0003). NS-192 slice 1 stores the approved
package (`application_package`). It adds `readHandoffPackage` (`packages/db`), which re-checks on
every read:
- the handoff is open and Paul's;
- the approval still verifies;
- the package still hashes to the content the Gate pinned.

The extension can't call a session endpoint: it runs on a `chrome-extension://` origin and has
only its own token (ADR-0019). But ADR-0019 is Accepted, and it limits that token to
`POST /jobs/capture`, with this consequence: "A leaked extension token can only capture jobs: no
approvals, no kill switches, no reads." Any way for the extension to get the package to fill
changes that. The package holds Paul's name, email, phone and approved answers. An agent can't
widen an accepted credential's reach on its own, so the endpoint waits on this record.

## Decision (proposed)
Paul picks one. The agent's recommendation is option 2.

1. **Read on the extension token.** `POST /handoffs/package` with `auth: "extension"` and a
   256-byte body limit. It takes a handoff id and answers with that open handoff's apply URL, ATS,
   contact and fields, or a fixed refusal code (`not_found`, `closed`, `no_package`,
   `not_approved`, `changed`).
   - The token can't list handoffs.
   - An attacker needs the token and a random 122-bit handoff id.
   - Only open handoffs with a live approval answer.
   - The cost: a leaked token plus a known id gives Paul's contact details and answers for that
     one form. ADR-0019's "no reads" is no longer true.
2. **A one-time grant from Paul's session.** The "Needs your hands" card on the web app (session
   only) asks for a grant: `POST /handoffs/prefill-grant` with `{ handoffId }`.
   - The grant is a random value, stored hashed, for that one handoff. It expires in 2 minutes and
     can be used once.
   - The card hands it to the extension through the deep link Paul clicks. The extension then
     calls `POST /handoffs/package` with the extension token and the grant, and the server checks
     both.
   - The cost: one more endpoint and a short-lived table. A leaked token alone still reads
     nothing, so ADR-0019's consequence stays true except in the 2 minutes after Paul's own
     click.
3. **No extension read.** The web app shows the package on the card, for Paul to copy by hand.
   This is the safest option, but it gives up the pre-fill that APPLY-006 asks for.

Whichever is chosen:
- The extension fills only the fields the ATS adapter maps, and only when the tab's host is one of
  that adapter's hosts and matches the apply URL.
- It never presses submit.
- A pre-fill writes `handoff.prefilled` (ids, ATS, field count; never values).

## Alternatives considered
- **Reuse the session cookie from the extension:** the cookie is SameSite=Strict on
  `northstar.localhost`, and loosening it would weaken the web app's CSRF defence (ADR-0018,
  ADR-0019).
- **Put the package in the deep link:** it would sit in the browser's history and the extension's
  URL, with no server-side check at the moment of use.

## Consequences
- Option 1: smallest change. The extension token becomes a read credential for open handoffs, and
  ADR-0019's consequence must be rewritten.
- Option 2: keeps "a leaked token alone reads nothing", at the cost of a grant table, an endpoint
  and its tests.
- Option 3: no new credential reach, and no automatic pre-fill.
- Until Paul accepts one, no endpoint serves the package. `readHandoffPackage` and the store exist
  and are tested, but nothing calls them.

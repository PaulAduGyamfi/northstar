# ADR-0030 — The pre-fill grant reaches the extension as a pasted one-time code

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27; option B chosen on #332) · **Date:** 2026-11-27 · **Amends:** ADR-0029's hand-off sentence ("The card
hands it to the extension through the deep link Paul clicks")

## Context
ADR-0029 (Accepted, option 2) lets the extension read one open handoff's approved package with a
one-time grant from Paul's session (APPLY-006, ACC-007). It says the card hands the grant over
"through the deep link Paul clicks", but not how. NS-192 slice 3 found that a real deep link into
the extension needs new manifest entries (`web_accessible_resources` and the ATS hosts) and puts
the grant in a URL. #332 laid out three ways; the orchestrator chose option B on 2026-11-27 under
Paul's delegation (comment on #332).

## Decision
The grant travels as a code Paul copies from the web app and pastes into the extension popup.
- **The code** is `<handoffId>.<grant>`: the handoff's UUID, a dot, and the grant from
  `POST /handoffs/prefill-grant` (43 base64url characters, 256 random bits). `prefillCode`
  (`apps/web/src/handoffs.ts`) builds it; `parsePrefillCode` (`apps/extension/src/prefill-run.ts`)
  accepts only that exact shape after trimming whitespace.
- **The card.** "Pre-fill" on "Needs your hands" asks for a grant and shows the code in a read-only
  field with a Copy button and a countdown to the grant's `expiresAt` (2 minutes). At zero the code
  is cleared. It lives in React component state only: never storage, a cookie or the URL.
- **The popup.** A paste field and a "Fill this form" button on the ATS tab. On Paul's click it
  sends the code once with `packageRequest`, re-reads the active tab's URL, runs `prefillPlan`, and
  injects `fillForm` into that tab's main frame only (`frameIds: [0]`). The field is cleared after
  each attempt. The code is held in memory only: never `chrome.storage`, a URL or a log.
- **No new permission.** The manifest stays `activeTab`, `scripting`, `storage` and
  `http://127.0.0.1/*`; `manifest.test.ts` is unchanged.

Everything else in ADR-0029 stands: the grant is single use, bound to one handoff, kept hashed in
the API's memory, and the package is re-checked at the moment of the read.

## Alternatives considered
- **A deep link into the extension (#332 option A):** needs `web_accessible_resources` and ATS host
  permissions, and puts the grant in a URL and the browser's history.
- **The web app writes the grant into extension storage (#332 option C):** needs storage of the
  grant and a messaging channel, against "send the grant, never store it".

## Consequences
- One extra step for Paul: copy, switch tab, paste. He is already handling that page himself.
- The grant sits in Paul's clipboard (and any clipboard history he keeps) for up to its 2 minutes,
  and is useless after one use. A leaked extension token alone still reads nothing.
- The code shape is now a contract between `apps/web` and `apps/extension`; each side has a test
  for it, and they must change together.

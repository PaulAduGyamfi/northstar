---
paths:
  - "apps/web/**"
  - "packages/ui/**"
---

# Web app and UI kit (ADR-0009: B · Momentum)

`apps/web` exists since NS-156 (a Next.js shell; Today, `/health` since NS-153, the Queue,
`/approvals`, since NS-139, the Pipeline, `/pipeline`, since NS-168, and Settings → Accounts,
`/settings/accounts`, since NS-198, linked from Today because the nav's five tabs are fixed). `packages/ui` doesn't exist yet: if
you are about to create it outside its ticket, stop and ask Paul. Until it lands, the color tokens
are CSS variables in `apps/web/app/globals.css`.

- Every page that shows Paul's data checks the session with `readSession` (`src/session.ts`, the
  API's `GET /me`) or `readApi` (`src/system.ts`), and renders nothing else when the API is
  unreachable (ADR-0018).
- A status is always shown in words as well as color (`.status-label`), never color alone.
- Fonts are never downloaded at build time: the build runs offline in CI.

- Use the tokens and components in `docs/design/tokens.md`. No ad hoc colors, fonts or radii.
- Light and night themes both work. WCAG 2.2 AA contrast. Never put lime text on a light background.
- Every swipe and drag has a visible button and a keyboard key (UX-043). Cards under review lock
  can't be swipe-approved (UX-041).
- Celebrations follow the ladder in tokens.md only. Respect `prefers-reduced-motion`.
- Rejections render as neutral "Closed" (`--closed`), never red. No guilt or loss copy (UX-045).
- One status vocabulary everywhere, from the application state machine (UX-020).
- Every score, skip and grade has a "why" (UX-014).
- No secrets in client code. The browser talks only to the API.
- A link to a page outside Northstar (an apply URL in "Needs your hands", NS-121) goes through
  `safeHref` (https only) and opens in a new tab with `rel="noopener noreferrer"`.
- Approvals are decided only through the API's session endpoints (`/approvals/*`, NS-139). An
  undo countdown reads the API's `effectiveAt` (the database clock); the browser only counts down.
- Application statuses are shown only through `STATUS_WORDS` (`src/pipeline.ts`, UX-020): every
  ending but an offer reads "closed" (UX-020, tokens.md).
- Passkeys (NS-178, ADR-0022) go through `src/passkey.ts` (`signInWithPasskey`, `addPasskey`),
  which takes the credentials container and fetch as arguments so tests need no browser. Adding
  one always asks for the sign-in key again; the key form stays on the sign-in page.
- Browser calls to the app's own API (`/api/*`) go through `apiFetch` (`src/client-fetch.ts`,
  NS-176): a 15 s limit. A POST that timed out may still have been applied, so its message is
  `TIMED_OUT_MESSAGE` ("may have gone through"), never "nothing was done".
- Settings → Accounts (NS-198) never shows an account email or password: rows are built field by
  field (`accountRows`, `noticeRows` in `src/accounts.ts`), and a notice's text is fetched only
  when Paul asks for it.
- The run inspector (NS-154) fetches a feed line's run (`GET /feed/run`) only when Paul asks, and
  shows it as plain text through `src/run.ts` (`callLine`, `totalsLine`).
- Pipeline filters (NS-207) live in the URL (`parseFilters`, `filterQuery` in `src/pipeline.ts`)
  and are applied by the API, never only in the browser. Today's counts (`src/today.ts`) come from
  the same lists their pages show; one that can't be read says so, never 0.
- Pipeline metrics (NS-208, `/pipeline/metrics`, `src/metrics.ts`): every rate shows its count,
  and one with too few data points reads "not enough data yet", never a percentage (DX-003).

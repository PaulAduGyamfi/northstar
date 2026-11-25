---
paths:
  - "apps/web/**"
  - "packages/ui/**"
---

# Web app and UI kit (ADR-0009: B · Momentum)

`apps/web` exists since NS-156 (a Next.js shell; Today, `/health` since NS-153, the Queue,
`/approvals`, since NS-139, and the Pipeline, `/pipeline`, since NS-168). `packages/ui` doesn't exist yet: if
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

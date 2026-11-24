---
paths:
  - "apps/web/**"
  - "packages/ui/**"
---

# Web app and UI kit (ADR-0009: B · Momentum)

These don't exist yet. If you are about to create one outside its ticket, stop and ask Paul.

When they land:

- Use the tokens and components in `docs/design/tokens.md`. No ad hoc colors, fonts or radii.
- Light and night themes both work. WCAG 2.2 AA contrast. Never put lime text on a light background.
- Every swipe and drag has a visible button and a keyboard key (UX-043). Cards under review lock
  can't be swipe-approved (UX-041).
- Celebrations follow the ladder in tokens.md only. Respect `prefers-reduced-motion`.
- Rejections render as neutral "Closed" (`--closed`), never red. No guilt or loss copy (UX-045).
- One status vocabulary everywhere, from the application state machine (UX-020).
- Every score, skip and grade has a "why" (UX-014).
- No secrets in client code. The browser talks only to the API.

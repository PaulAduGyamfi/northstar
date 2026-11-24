# Design — UI direction selection (UX-000)

**Status: DECIDED 2026-11-24. Product owner chose B · Momentum** (ADR-0009). Tokens and components are in [tokens.md](tokens.md). Guardrails for B's known risks are UX-040…047 in `requirements/12-ui-ux.md`. The other directions are kept for reference.

All mockups show the same day and data (Today/Home), so the comparison is about design, not content. Open the `.html` files in a browser, or see the `.png` renders.

| Direction | Mood | Files |
|---|---|---|
| **A · Mission Control** | Calm, warm-dark command center. Keyboard-first, with a dense intent-preview queue and a live activity log. | [a-mission-control.html](mockups/a-mission-control.html) · [png](mockups/a-mission-control.png) |
| **B · Momentum** | Energetic and game-like. Swipe card stack, weekly ring, quests, an "agent crew" chat. | [b-momentum.html](mockups/b-momentum.html) · [png](mockups/b-momentum.png) |
| **C · The Daily Edition** | Editorial. Your search as a morning paper, with prose rationales and dispatches. | [c-daily-edition.html](mockups/c-daily-edition.html) · [png](mockups/c-daily-edition.png) |
| **D · Hybrid (recommended)** | A's structure and keyboard speed, C's headline lede and italic "why", B's ring, earned celebrations and forgiving streaks. Light theme shown (dark = A's palette). | [d-hybrid.html](mockups/d-hybrid.html) · [png](mockups/d-hybrid.png) · [mobile](mockups/d-hybrid-mobile.png) |

Patterns shared by every direction (from the [research brief](research-brief.md)):
- Fit score broken into parts with a reason.
- Freshness chip.
- A "needs your hands" card for handoffs.
- Batch approve that keeps per-item review.
- An undo window after submit.
- Closed applications shown in neutral gray and routed to Diagnostics.
- A bounded activity feed that ends with "Agents keep watching".

Once a direction is chosen: write `tokens.md` (color, type, spacing, motion), a component inventory, then clickable prototypes of Approvals, Pipeline, Growth and Diagnostics for UX-002.

**Clickable prototype (NS-107):** [prototypes/index.html](prototypes/index.html), with synthetic
data and no build step (double-click to open). It covers Today, Queue (cards and compact),
Pipeline, Grow, Diagnostics, Settings and the ⌘K palette, in light and night themes. The UX-002
protocol and results are in [prototypes/usability-check.md](prototypes/usability-check.md).
Renders are in [prototypes/renders/](prototypes/renders/).

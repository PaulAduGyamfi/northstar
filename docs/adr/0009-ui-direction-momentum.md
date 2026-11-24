# ADR-0009 — UI direction: B · Momentum

**Status:** Accepted (product owner, 2026-11-24) · **Date:** 2026-11-24

## Context
UX-000 required choosing between four mockup directions before any UI is built (A Mission Control, B Momentum, C Daily Edition, D Hybrid). The research brief recommended D. The product owner chose **B · Momentum**: the energetic, game-like direction. It fits the core requirement best: *the UI must not be boring, or automating the boring part is pointless.*

## Decision
Build on **B · Momentum**: warm light canvas, ink/coral/lime/iris palette, Bricolage Grotesque headlines, springy motion, a card-stack approval flow, weekly input ring, quests, and the "agent crew" activity feed. Tokens are in `docs/design/tokens.md`.

The research flagged four risks with B. Each is handled by a guardrail inside B's style, not by switching direction (requirements UX-040…UX-047):

| Risk | Guardrail |
|---|---|
| Swiping invites rubber-stamping bad applications | Cards with new narrative answers or a low-confidence match can't be swipe-approved. They open for review first. Batch approve covers only cards above the confidence line. |
| Too slow for high volume | A **Compact** view of the queue (dense list, J/K/A/S keys) sits one toggle away. Same data and actions. |
| Patronising or hollow during a long dry spell | Adult tone: no mascots, no exclamation-mark copy. Celebrate inputs and leading indicators. Big celebrations are reserved for rare events. |
| Quests become obligations or guilt | Weekly targets, not daily ones. Rest days are banked automatically. Progress decays slowly instead of resetting. Missing a quest never produces negative copy. |

## Consequences
- + The most distinctive and motivating option; clearly unlike competitor dashboards.
- − More motion and illustration work, so a higher build cost. Mitigated by a small, fixed set of animated components.
- Dark theme ("night mode", base `#121018`) is required, not optional (UX-019).

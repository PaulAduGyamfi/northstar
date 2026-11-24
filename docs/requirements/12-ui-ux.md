# 12 — UI / UX

Product owner (2026-11-24): the UI must be **easy to read, understand, navigate and use**, and **not boring at all**. A boring UI defeats the point: we are making applying less work and less tedious while getting better results than applying by hand.

**Gate:** No production UI is built until the product owner has seen mockups of several visual directions and **approved one** (UX-000). The chosen direction is recorded in `docs/design/` with its tokens.

## Process
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| UX-000 | M | P0 | Research-backed design brief → 3 distinct mockup directions covering the same key screens → product owner approves one → design tokens and component inventory derived from it → build. |
| UX-001 | M | P0 | Mockups cover at least: **Today**, **Approval Queue**, **Activity Feed**, **Pipeline**, **Growth Tracker**, and the mobile approval flow. |
| UX-002 | S | P1 | Lightweight usability check: the product owner completes 5 core tasks on the clickable prototype without help (approve a batch, find why a job was skipped, change comp floor, see what failed, log growth progress). |

## Usability requirements
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| UX-010 | M | P1 | **Answer "what needs me right now?" in ≤ 3 seconds** from opening the app (Today view: approvals waiting, needs-human, interviews soon, follow-ups due, today's growth block). |
| UX-011 | M | P1 | **≤ 1 click per application** in the common case: batch approve from Today or from a push notification. Keyboard: `A` approve, `E` edit, `S` skip, `J/K` navigate. |
| UX-012 | M | P1 | **Command palette** (`Ctrl/⌘ K`) to jump anywhere or do anything (paste a job link, change a setting, pause auto-apply). |
| UX-013 | M | P1 | **Navigation** with ≤ 8 top-level sections, consistent placement, readable labels (no unexplained jargon or icons without labels). |
| UX-014 | M | P1 | **Explain-why everywhere:** every score, skip, grade and status has a one-click "why" with evidence (ties to OBS-003, MAT-002). |
| UX-015 | M | P1 | **Live but calm:** real-time activity is visible (feed, progress, counters) without notification noise. Motion is purposeful and respects `prefers-reduced-motion`. |
| UX-016 | M | P1 | **Undo over confirm:** reversible actions use undo toasts instead of confirmation dialogs. Irreversible ones (submit, send) use clear, specific confirmation or the approval queue. |
| UX-017 | M | P1 | **Settings anywhere:** target roles, comp, locations, autonomy dial and caps are editable from Settings and inline where they matter (SRC-017). |
| UX-018 | M | P1 | **Responsive PWA:** approve, edit an answer, and check status fully on mobile. |
| UX-019 | M | P1 | **Accessibility:** WCAG 2.2 AA contrast, full keyboard support, visible focus, screen-reader labels, light and dark themes. |
| UX-020 | M | P1 | **Status vocabulary** is consistent everywhere (one color and label per application state, matching the state machine in 03). |

## Engagement and motivation requirements (not boring)
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| UX-030 | M | P1 | **Momentum visuals:** progress toward weekly goals, streaks for growth tracks, time-to-apply records, and a contribution-style heatmap of activity. Shows effort compounding. |
| UX-031 | M | P1 | **Delight moments** at meaningful events (application submitted in the first hour, interview booked, milestone shipped, cert passed). Tasteful, short, skippable. |
| UX-032 | M | P1 | **Emotionally safe framing** (ties to DX-016): rejections are shown as data feeding the diagnosis, never as a wall of red. Leading indicators are celebrated. No shame mechanics (e.g. no "you broke your streak!" guilt). |
| UX-033 | S | P2 | **Personality:** a consistent voice in microcopy (confident, warm, brief) and a visual identity that feels premium and alive, not a generic admin dashboard. |
| UX-034 | S | P2 | **Weekly recap** as a beautiful, shareable-to-self summary (DSH-005, DX-014). |

## Chosen direction: B · Momentum (ADR-0009, 2026-11-24)
These requirements keep B's energy while guarding against the risks the research found.

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| UX-040 | M | P1 | Build to the B tokens and components in `docs/design/tokens.md`. Light and night themes both ship in P1. |
| UX-041 | M | P1 | **Review lock:** cards with new narrative answers, below-line confidence, a first-time form, or any provenance warning **can't be swipe-approved**. A swipe opens the card for review instead. Only reused or high-confidence packages can be approved with one swipe or key. |
| UX-042 | M | P1 | **Compact queue view:** a one-toggle dense list of the same queue for keyboard triage (J/K/A/S/E), for high-volume days. Remembers the last view. |
| UX-043 | M | P1 | **Non-drag alternatives:** every swipe has a visible button and a key (WCAG 2.2 SC 2.5.7). Every journey move has a menu. |
| UX-044 | M | P1 | **Celebration ladder** exactly as in tokens.md. Big celebrations only for interview, offer, cert passed, project shipped. Never for routine actions. |
| UX-045 | M | P1 | **Forgiving progress:** weekly targets, rest days banked automatically (default 2/week), slow decay instead of resets, a "minimum viable day" (approve 1 thing or 15 min of growth). No loss or shame copy anywhere. |
| UX-046 | M | P1 | **Adult tone:** no mascots or cartoon characters. Agent names are functional (Scout, Tailor, Answerer, Inbox, Coach, Planner). Microcopy is confident, warm and short. |
| UX-047 | S | P1 | **Fresh-first power hour:** queue sorted by freshness × fit (SRC-013), with "posted N min ago" as the most prominent tag on every card and push notification. |

## Research input
A research agent is producing the design brief (patterns from leading agentic and productivity products, motivation design, competitor gaps, 3 directions). Its output becomes `docs/design/research-brief.md` and the mockups live in `docs/design/mockups/`.

# 09 — Growth Tracker (Projects & Skills)
Covers user ask **#15**: a separate section to track project / skill growth and **balance** work across many tracks, since not every track can be touched every day.

## Initial tracks (from product owner, 2026-11-24)

| Track | Type | Status | Source / link | Notes |
|---|---|---|---|---|
| Backpocket | Side project | Active | — (repo TBD) | |
| Countersign | Side project | **Backlogged** | — | Parked; resurfaces only on explicit decision |
| AWS Solutions Architect Associate | Course → certification | Active | Udemy course (user-provided share link) | End goal: pass SAA exam; Credly badge feeds VIS-001 |
| Anthropic FDE pathway | Course path | Active | anthropic-partners.skilljar.com/path/claude-fde | Directly relevant to FDE/AI-engineer target roles |
| Scripture Challenge — production hardening | Project | Active | Claude artifact (user-provided link) | Hardening backlog TBD (Q-09) |

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| GRW-001 | M | P2 | **Tracks** with type (project, course, cert, skill), status (active, paused, backlogged, done), goal, target date, and definition of done. |
| GRW-002 | M | P2 | **Milestones & next actions.** Each track breaks into milestones (e.g. SAA: sections 1–N, practice exams ≥ 80%, exam booked) and always has one concrete next action sized ≤ 90 min. |
| GRW-003 | M | P2 | **Weekly capacity planning.** User sets weekly hours (and energy windows). Planner allocates hours across active tracks by priority weights, deadlines, and decay, and proposes calendar blocks (CAL-001). One approval per week. |
| GRW-004 | M | P2 | **Balance rules.** WIP limit on active tracks (default 3 in focus per week, others in maintenance); "no track untouched > N days" (per-track N); rotation so each focus track gets ≥ 2 sessions/week. |
| GRW-005 | M | P2 | **Progress capture with low friction.** Auto-detect progress where possible — GitHub commits/PRs for project repos, course completion % (manual or extension-read from Udemy/Skilljar pages), artifact versions — plus a 10-second manual check-in. |
| GRW-006 | M | P2 | **Dashboard**: per-track progress bars, streaks, hours this week vs. plan, last-touched age, burndown to target date, "at risk" flags. |
| GRW-007 | S | P2 | **Weekly review** ritual (scheduled, 15 min): what moved, what slipped, re-plan next week; produces a short log. |
| GRW-008 | S | P3 | **Skill-gap loop.** Aggregate unmatched JD requirements (MAT-005) and interview weak spots (CAL-007) into "market demand" signals; suggest re-weighting tracks (e.g. "38% of your target roles want AWS → keep SAA in focus"). |
| GRW-009 | S | P3 | **Proof-of-work pipeline.** Milestones completed become profile assets: README updates, LinkedIn post drafts, certification badges, resume atoms (CPG-002) — each a draft for approval. |
| GRW-010 | C | P4 | Learning notes per track; generate flashcards for cert prep with spaced repetition. |

## Acceptance criteria (selected)
- **GRW-003:** Given 10 h/week and 4 active tracks with WIP limit 3, the planner puts 3 in focus, 1 in maintenance, and every focus track gets ≥ 2 blocks.
- **GRW-004:** A track exceeding its untouched threshold appears as "at risk" and is prioritized in next week's plan unless the user pauses it.
- **GRW-009:** Passing SAA creates a draft resume atom, a Credly-link task, and a LinkedIn certification post draft.

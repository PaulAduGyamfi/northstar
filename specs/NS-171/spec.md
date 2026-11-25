# NS-171: The weekly growth planner (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: GRW-001 (track shape), GRW-002 (one next action ≤ 90 min), GRW-003 (weekly
capacity), GRW-004 (WIP, untouched threshold, two sessions per focus track); storage, settings,
calendar blocks and the approval follow up
Rules that apply: AGENTS.md "Code decides, the model drafts"; `.claude/rules/tests.md`; Q-09
(defaults 8 h/week, WIP 3)

## Why
Paul has more growth tracks than hours: side projects, a certification course, a course path and
a hardening backlog. Not every track can move every week. The planner decides each week which
tracks are in focus and which only get maintenance, and how the hours split, so nothing silently
goes stale. It must be plain code (no model), the same input always giving the same plan.

## Behavior
`packages/domain`, `growth.ts`, pure code with no I/O:

1. **Tracks** (GRW-001): id, name, type (`project`, `course`, `cert`, `skill`), status (`active`,
   `paused`, `backlogged`, `done`), priority (1–5), optional target date, when it was last touched,
   its own untouched threshold in days (default 7), and its next action (title and minutes), if any.
2. `planWeek(tracks, settings, now)` returns the week's plan:
   - Only `active` tracks are planned; the others are listed as not planned, with their status as the
     reason.
   - **At risk** (GRW-004): an active track never touched, or untouched longer than its threshold.
   - **Order:** at-risk tracks first, then higher priority, then the nearer target date (none
     last), then id, so the order never depends on input order.
   - **Focus and maintenance:** the first `wipLimit` tracks (default 3) are in focus, the rest in
     maintenance.
   - **Hours:**
     - each maintenance track gets one block of `maintenanceMinutes` (default 30);
     - each focus track gets at least `minFocusSessions` blocks (default 2) of `blockMinutes`
       (default 60, at most 90);
     - any blocks left over go round-robin in focus order;
     - the week never exceeds `weeklyMinutes` (default 480: Q-09's 8 hours).
   - **Over capacity:** if the hours can't give every focus track its minimum sessions after
     maintenance, focus shrinks to as many tracks as fit and the rest move to maintenance, marked
     `over_capacity`. Maintenance blocks that don't fit are left out, marked `no_time` (one note per
       track: `no_time` wins).
   - **Next actions** (GRW-002): an active track whose next action is missing or longer than 90
     minutes is flagged `needs_next_action`.
3. `parsePlanSettings` checks the settings (weekly minutes 0–10080, WIP 1–10, block 15–90 minutes,
   maintenance 0–90 minutes, minimum sessions 1–7), filling in the Q-09 defaults.

## Acceptance criteria
- [ ] Given 10 h/week and 4 active tracks with WIP 3, three are in focus and one in maintenance,
      and every focus track gets at least 2 blocks (GRW-003's own case).
- [ ] An untouched track past its threshold is marked at risk and planned before a higher-priority
      track that isn't (GRW-004).
- [ ] Paused, backlogged and done tracks are never planned.
- [ ] The total never exceeds the weekly minutes, for any input (a property-style test over many
      inputs).
- [ ] With too few hours, focus shrinks and the moved tracks say `over_capacity`.
- [ ] A missing or over-90-minute next action is flagged.
- [ ] The same input in a different order gives the same plan.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
None at run time: pure code. Bad settings are refused by `parsePlanSettings` with the field names.

## Observability
None yet: nothing calls it. The caller that stores a plan (a follow-up) emits its event.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #122`)
- Storing tracks, milestones, plans and settings (`packages/db`), and a CLI or page to edit them.
- Energy windows and calendar blocks (CAL-001), and the one approval per week (GRW-003).
- Deadlines and decay as weights beyond the ordering above.

## Open questions
- Is a 60-minute default block right? GRW-002 caps a next action at 90 minutes, so blocks stay
  at or under that.

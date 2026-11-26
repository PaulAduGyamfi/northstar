# NS-172: Growth check-ins, dashboard figures and the weekly review (slice 1)

Status: built, in review (autonomous lane, ADR-0016)
Requirements: GRW-005 (manual check-in), GRW-006 (dashboard figures), GRW-007 (weekly review);
auto-detected progress, storage and the page follow up
Rules that apply: AGENTS.md "Code decides, the model drafts"; UX-030, UX-032 (no shame
mechanics); `.claude/rules/tests.md`

## Why
NS-171 plans a week. Paul then needs to say what he did in ten seconds, see how each track is
going, and close the week with a review that feeds the next plan. All of that can be decided by
plain code over check-ins, before anything is stored or drawn.

## Behavior
`packages/domain`, `growth-progress.ts`, pure code with no I/O:

1. **Check-ins** (GRW-005): `parseCheckIn` checks a manual check-in (track id, when, minutes 1–600,
   optional percent complete 0–100). There is no free-text field, so nothing of Paul's words is
   kept here.
2. `applyCheckIns(tracks, checkIns)` returns the tracks with each `lastTouchedAt` moved to its
   newest check-in (never earlier than it was). This is how the review feeds `planWeek`: a track
   with no check-in keeps aging and becomes at risk on its own (GRW-004).
3. `trackDashboard(tracks, checkIns, plan, weekStart, now)`, one row per track (GRW-006):
   - minutes done this week (from `weekStart`, 7 days) against minutes planned;
   - days since last touched (never negative), and at risk: the planner's own `isAtRisk`, for
     active tracks only, so a paused or finished track never shows at risk;
   - a streak in weeks: the run of weeks with at least one check-in. The current week counts only
     once it has one; until then the run continues from last week. It never resets mid-week and
     never says "broken" (UX-032);
   - the latest percent complete, if any, and with a target date the percent per week still
     needed to finish by it.
4. `weeklyReview(tracks, plan, checkIns, weekStart)` (GRW-007):
   - **moved:** each track with minutes this week, with done against planned;
   - **not reached:** each planned track with none;
   - a short log in neutral words, for example "Track A: 90 of 120 min" and "Track B: not reached
     this week". It adds "it goes first in next week's plan" only when the planner's own rule says
     so at next week's start, so it never promises what the planner won't do. There is no guilt
     copy.

## Plan
1. `growth-progress.ts`: `parseCheckIn`, `applyCheckIns`, `trackDashboard`, `weeklyReview`; the
   at-risk rule, `DAY_MS` and `ValidDate` shared from `growth.ts`, not copied.
2. Tests first for each acceptance criterion; export from `index.ts`; AGENTS.md line.

## Tasks
- [x] Check-in validation (minutes and percent ranges).
- [x] `applyCheckIns` forward only, feeding `planWeek`.
- [x] Dashboard minutes, days, at risk (active only), streak, percent pace.
- [x] Review moved / not reached with a truthful, neutral log.

## Acceptance criteria
- [ ] A check-in outside 1–600 minutes or 0–100 percent is refused, naming the field.
- [ ] `applyCheckIns` moves `lastTouchedAt` forward to the newest check-in and never back; a
      track touched this way is no longer at risk in the next `planWeek`.
- [ ] The dashboard counts only this week's check-ins against the plan's minutes for that track.
- [ ] The streak counts consecutive weeks; a week not yet checked into doesn't reset it, and a
      fully missed past week does.
- [ ] With a target date and a percent, the percent per week needed is (100 − percent) ÷ weeks
      left, and is null without either.
- [ ] The review lists moved and not-reached tracks, and its log has no "missed", "failed" or
      "broke" wording (a test over the log).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
None at run time: pure code. Bad check-ins are refused by `parseCheckIn` with the field names.

## Observability
None yet: nothing calls it. The caller that stores check-ins (#190's storage) emits the events.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #123`)
- Auto-detected progress: GitHub commits and PRs (needs the GitHub API: network and a token),
  course percent read by the extension, artifact versions.
- Storing check-ins and reviews, the scheduled weekly review, and the dashboard page (UX-030's
  heatmap).

## Open questions
- Is a week streak (not a day streak) the right unit? Not every track can be touched every day
  (GRW-004), so days would punish the plan working as designed.

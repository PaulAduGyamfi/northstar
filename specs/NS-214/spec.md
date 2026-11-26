# NS-214: Growth page in the app: check-ins, dashboard and the weekly review

Status: built
Requirements: GRW-005 (10-second check-in), GRW-006 (dashboard), GRW-007 (weekly review), UX-032
(no shame copy), DSH (session-only pages)
Rules that apply: ADR-0016, ADR-0018 (sign-in), `.claude/rules/db.md`, `.claude/rules/web.md`,
`.claude/rules/tests.md`. Parent: #123. Builds on NS-171/NS-172 (`packages/domain`) and NS-210
(tracks, touches, settings and plans in `packages/db`).

## Why
The planner, check-in parser, dashboard figures and weekly review exist as plain code, and tracks
and plans are stored, but nothing stores a check-in or shows any of it. Paul needs a Grow tab:
log a session in ten seconds, see each track at a glance, and read last week's review.

## Behavior
### Storage (`packages/db`, `growth-schema.ts`, `growth-write.ts`)
- `growth_check_in` (append-only): candidate, track key, time, minutes (1–600), percent (0–100 or
  null), the client's idempotency key (unique per candidate). `recordCheckIn` refuses a key that
  isn't a current track (`UnknownTrack`), stores nothing for a repeated idempotency key
  (`replayed`), and writes `growth.checked_in` (row id and minutes only).
- `growth_review` (append-only): one per candidate and Monday-start week, holding the review's
  `moved` (track key, minutes, planned minutes) and `notReached` (track keys). `saveWeekReview`
  stores a week once and returns the stored one after; `growth.reviewed` carries the review's id,
  the week and two counts.
- `readCheckIns(since)`, `readWeekPlan(week)`, `readWeekReview(week)`.
- A track's last touch (`readGrowthTracks`) is now its newest touch or check-in, so `profile
  growth plan` sees check-ins too (GRW-005 feeds the next plan).
- Migration 0066 (tables) and 0067 (append-only triggers, then `northstar_grant_app_role()`).

### Domain
- `weekStartOf(now)` (the Monday, UTC, as `YYYY-MM-DD`) moves from `packages/profile` to
  `packages/domain` (`growth-progress.ts`); the profile CLI imports it.

### API (`apps/api/src/growth.ts`, `auth: "session"`)
- `GET /growth`: this week's start; whether a plan is stored for it (if not, the figures use a
  preview from `planWeek`, nothing is stored); one row per current track with its name, type,
  status and `trackDashboard`'s figures; last week's stored review, if any.
- `POST /growth/check-ins` `{ key, minutes, percent, idempotencyKey }`: time is the server's now.
  `unknown_track` (404), `invalid_input` (400).
- `POST /growth/review`: reviews last week from its stored plan, its check-ins and the current
  tracks, and stores it once. `no_plan` (409) when last week has no stored plan.

### Web (`apps/web`, the nav's Grow tab, `/grow`)
- Each track: name, type and status in words; a progress bar for the percent with the number
  beside it; "45 of 120 min this week"; "Last worked on 3 days ago" or "Not worked on yet"; "At
  risk: it goes first in next week's plan" when at risk; "2 weeks in a row" when there is a streak (never a
  broken-streak line, UX-032); the weekly pace still needed, when known.
- A check-in form: track, minutes, optional percent; one idempotency key per form load, so a
  double submit stores one.
- "Review last week" button and, once stored, the review's log lines.
- Signed out redirects to sign-in; an unreachable API says so in words.

## Acceptance criteria
- [x] A check-in shows on the dashboard at once; saving it twice with the same idempotency key
      stores one (db test and API test).
- [x] An unknown track key stores nothing; events carry no track key or name.
- [x] A week's review is stored once; the second call returns the first; no plan → `no_plan`.
- [x] A check-in moves the track's last touch for the planner.
- [x] The page shows only the listed fields, every status in words (web helper tests).
- [x] Every table's grants match the app-role rule (`app-role.test.ts`).
- [x] `pnpm turbo run lint typecheck test build` passes; `drizzle-kit generate` has no changes.

## Failure modes
- API down: the page says the API isn't answering; the form shows "Couldn't reach Northstar".
- Postgres error on a check-in: 503, the form says try again; nothing half-stored (one
  transaction with the event).
- No tracks yet: the page says how to add them (`profile growth tracks set`).

## Observability
`growth.checked_in`, `growth.reviewed` (feed lines from their fixed `reason`), spans
`growth.check_in` and `growth.reviewed`, and the API's `api.request` span.

## Out of scope
Auto-detected progress (GitHub, course pages), the heatmap (UX-030), milestones (#250), editing
tracks from the app.

## Open questions
- None.

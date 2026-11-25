# NS-153: System Health page, live activity feed and kill-switch toggles in the app

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RES-013 (health model and status in the app), OBS-002 (activity feed in the app,
new items within 5 s), RES-008 (kill switches, effective within 10 s, in the feed). GitHub issue
#99 (`agent-filed`, `Parent: #24`).
Rules that apply: ADR-0002 (only Paul's authenticated UI path may call `setKillSwitch`),
ADR-0007, ADR-0018 (sessions, request checks), `.claude/rules/web.md` (tokens, "Closed" never red,
no secrets in client code), `.claude/rules/db.md` (feed and health views are read-only; feed text
only from `feedLine`), `.claude/rules/tests.md`.

## Why
NS-125 and NS-126 built the health model, the plain-sentence feed and stored kill switches, but
Paul can only see or flip them from code. The app now has a signed-in shell (NS-156) to show them.

## Behavior
1. **API** (`apps/api`, every endpoint `auth: "session"`):
   - `GET /system/health`: `readSystemHealth`, as `{ overall, subsystems: [{ subsystem, kind,
     health, reason, retryAt }] }`, worst first. If the state can't be read (Postgres down), the
     endpoint answers 503, and the web app shows the whole system as down.
   - `GET /feed?before=<position>` (a page, newest first, from `readFeed`) and
     `GET /feed?after=<position>` (what's new since the newest item shown, oldest first, from a new
     read-only `readFeedAfter` in `packages/db`). At most 50 items. Positions travel as strings.
   - `POST /system/kill-switches { subsystem, enabled, reason }`: `setKillSwitch` with
     `actor: "user"`. A bad subsystem name or an empty reason is 400. The switch's
     `kill_switch.set` event shows in the feed, as NS-126 writes it.
   - GET endpoints read their input from the query string (the endpoint pattern's Zod schema
     applies to it).
2. **Web** (`apps/web`):
   - `/health` (signed in only, like Today): overall status, then each subsystem worst first, with
     its reason and, for a paused dependency, when it is tried again. A down subsystem is shown in
     `--coral-text` with a label, never red. When the API can't read the state, the page says the
     whole system is down.
   - Kill switches on `/health`: the fixed subsystems (`auto_apply`, `outreach_send`,
     `inbox_auto_label`), every source with a watched board (`source:<ats>`), and any other
     subsystem already switched. Each shows on or off with a button to flip it, which asks for a
     reason first. The page refreshes after a flip.
   - A health dot in the nav: green, amber or coral by overall status, linking to `/health`, with
     a text label for screen readers.
   - The activity feed on Today: the latest 20 lines, then new lines added at the top every 3 s
     (`GET /feed?after=`). Polling, not a pushed stream, for this slice: 3 s meets OBS-002's 5 s,
     and nothing long-lived has to pass through the Next proxy.
3. The feed shows only `feedLine` text. Names of jobs and companies in feed lines (a join from the
   aggregate id) are a follow-up issue.

## Acceptance criteria
- [ ] Each endpoint refuses a request without a session (401).
- [ ] `GET /system/health` returns the health model, and 503 when it can't be read.
- [ ] `GET /feed` pages backwards with `before`, returns only newer items with `after`, refuses
      both together or a bad position (400), and caps the page at 50.
- [ ] `POST /system/kill-switches` flips a switch with Paul as the actor, and refuses an unknown
      subsystem or an empty reason (400).
- [ ] `readFeedAfter` returns only events after the position, oldest first, as feed lines (PGlite).
- [ ] The switch list, the dot's status and the feed merge are plain functions with tests (web).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Postgres down:** health answers 503 and the page shows "down". The feed keeps the lines it
  has, and polling resumes when the API answers again.
- **A flip fails:** the button says so and the switch keeps its shown state.

## Observability
`api.request` spans as today. `kill_switch.set` events and the `kill_switch.set` span come from
`setKillSwitch` (NS-126). `feed.read` and `health.read` spans come from `packages/db`.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #99`)
- Names in feed lines (join aggregate ids to jobs and applications in the API).
- A pushed stream (SSE) once the worker writes events continuously.

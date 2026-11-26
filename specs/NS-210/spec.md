# NS-210: Store growth tracks, settings and weekly plans, with a plan command (slice 1)

Status: accepted (autonomous lane, ADR-0016)
Requirements: GRW-001 (tracks), GRW-002 (next actions), GRW-003 (weekly plan, without calendar
blocks), GRW-004 (balance rules)
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #122

## Why
`planWeek` (NS-171) decides a week from tracks and settings, but nothing stores them and nothing
runs it.

## Behavior
1. **packages/profile** (`growth-file.ts`, plain code): `parseGrowthTracks(text)` reads Paul's
   tracks file, one track per line:
   `key | name | type | status | priority [| target YYYY-MM-DD] [| untouched <days>] [| next <minutes> <title>]`
   - `key` is Paul's short id (`a-z0-9-`, at most 40), unique in the file; the rest is checked by
     `parseGrowthTrack` (`packages/domain`). A file with any bad line stores nothing and names each
     line.
2. **packages/db** (one migration, append-only by triggers):
   - `growth_track_set` (a version per stored file, with its SHA-256) and `growth_track`;
     the newest version is current, the same content stores nothing.
   - `growth_touch` (track key, time): a track's last touch is its newest touch.
   - `growth_settings` (the five `PlanSettings` numbers): the newest row is current; none means
     the defaults (Q-09).
   - `growth_plan`: one per week (Monday, UTC) per candidate, the plan as `planWeek` returned it;
     planning the same week again returns the stored plan and stores nothing.
   - Events: `growth.tracks_set` (version and counts), `growth.touched` (the touch id),
     `growth.planned` (the week and counts). Never a key, name, goal or next action. Each has a
     feed line.
3. **CLI** (`profile growth …`, Paul only):
   - `growth tracks set data/<file>` / `growth tracks` (list with each track's last touch);
   - `growth touch <key>` (records a touch for a current track);
   - `growth settings set <field> <value>` / `growth settings`;
   - `growth plan` plans this week (or prints the stored plan): focus with blocks, maintenance,
     at risk, needs a next action, notes and unplanned, by key and name.

## Acceptance criteria
- [ ] A good tracks file parses; each bad case names its line and stores nothing.
- [ ] Planning the same week twice stores one plan, and returns the first.
- [ ] A paused track never appears in focus or maintenance of a stored plan.
- [ ] A touch moves the track's last touch, which the next week's plan uses.
- [ ] No track key, name, goal or next action appears in any event or span.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
A bad file or value stores nothing and says why. Touching an unknown key stores nothing.

## Observability
The three events above, each with a feed line; spans carry counts only.

## Out of scope
- Milestones (GRW-002's breakdown) and the definition of done: a follow-up issue.
- Calendar blocks and the one weekly approval (GRW-003, CAL-001): they need Google Calendar
  (NS-169). The dashboard and check-ins are NS-214 (#197).

## Decisions made without Paul (ADR-0016)
- **The commands live in `packages/profile`'s CLI** (`profile growth …`): there is no growth
  package in system-design §7, and adding one is a new folder; the profile CLI already holds
  Paul's other self-describing data (work, facts, settings).
- **Tracks come from a file**, one line each, like `profile facts set` and `profile work set`:
  one command adds, edits, pauses or removes tracks, and history stays.
- **Track keys stay out of events**: a key is Paul's own word for the track, so events carry
  row ids and counts only.
- **Weeks start Monday, UTC.**
- **Schema change:** one migration with five append-only tables.

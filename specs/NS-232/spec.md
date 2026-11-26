# NS-232: Growth milestones, and each track's goal and definition of done

Status: done
Requirements: GRW-001 (goal, definition of done), GRW-002 (milestones)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #190, issue #250.

## Why
NS-210 stores Paul's growth tracks from his file, each with its next action. GRW-001 also asks
for a goal and a definition of done per track, and GRW-002 for ordered milestones, each with an
optional done date.

## Behavior
- **The tracks file** gains indented lines under a track (spaces before the text). Each belongs to
  the track line above it:
  - `goal: <text>` and `done when: <text>`: at most one each, 1 to 300 characters;
  - `- <milestone> [| done YYYY-MM-DD]`: in order, at most 20 per track, a title of 1 to 200
    characters, with an optional real done date.

  An indented line before any track, an unknown indented line, a second goal or definition of
  done, a bad done date, or too many milestones names its line and stores nothing (NS-210's rule).
  Track lines are read as before, and a file without indented lines parses to the same values as
  before. A track line that starts with spaces is now an indented line and is refused (nothing is
  stored); a tab before an indented line gets its own message.
- **Storage** (`packages/db`):
  - `growth_track` gets `goal` and `done_when` (nullable, the length and control-character
    CHECKs).
  - A new append-only `growth_milestone` table holds the milestones: per track row, with its
    position, title and optional `done_on`, and the same-candidate foreign key.
  - They are stored with the track version in the same transaction, and the version's hash
    covers them. A file without them hashes as before, so it isn't stored again.
  - `readGrowthTracks` reads them back in order.
- **`profile growth tracks`** prints each track's goal, definition of done and milestones (done or
  open) under its line.
- They are Paul's words: no event, span or error carries them (a test).

## Acceptance criteria
- [x] A file with goals, definitions of done and milestones parses; each bad indented line names
      its line and stores nothing.
- [x] Milestones are stored with the version and read back in order with their done dates.
- [x] No goal, definition of done or milestone appears in any event or span.
- [x] AGENTS.md and `.claude/rules/db.md` describe them.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A schema change (two columns, one table), and the file syntax above.
- The new fields are left off a track when absent, so the existing reads and their tests are
  unchanged.
- The diff is about 565 lines without generated files, over ~300: about half are tests.

## Out of scope
- Milestones in the planner, the Grow tab or the weekly review; a settings page.

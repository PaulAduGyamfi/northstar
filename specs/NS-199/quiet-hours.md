# NS-199 slice 2: quiet hours as a stored setting

Status: in progress (autonomous lane, ADR-0016)
Issue: #172, item 2
Requirements: SRC-015 (quiet hours, tier-1 rule "configurable"), SRC-017 (editable any time, no
onboarding-only fields)
Rules that apply: ADR-0012 (append-only events), ADR-0016, `.claude/rules/db.md`,
`.claude/rules/tests.md`

## Why
Quiet hours, their time zone and whether tier-1 boards may break them are read only from
`ALERT_*` settings in `.env`, so Paul has to edit a file and restart to change them. SRC-017 says
search settings are editable at any time, with nothing fixed at setup.

## Behavior
- A new append-only `alert_setting` table holds versions of the three settings per candidate:
  quiet hours (start and end in minutes after local midnight, or off), the time zone (an IANA
  name) and `tier1_in_quiet_hours`. A field left null in a version means "use the default".
- `setAlertSettings(db, candidateId, change)` (`packages/db`) merges one change into the newest
  version and stores a new version, plus an `alerts.settings_changed` event, in one transaction.
  The event payload holds the field names only (`changed: ["quiet"]`), and the feed line is fixed:
  "Changed the fresh-job alert settings". Setting the values a field already has stores nothing.
  `readAlertSettings` returns the newest version, or null.
- `effectiveAlertConfig(defaults, stored)` (`packages/sources`, plain code) uses each stored
  field where it is set, and the `ALERT_*` default otherwise, and says where each value came from.
- Every alert pass (`jobs score`, `jobs poll`, each capture) reads the stored settings at that
  moment, so a change applies on the next pass without a restart.
- `jobs alerts` prints the effective settings and their sources. `jobs alerts set quiet
  <HH:MM-HH:MM|off>`, `jobs alerts set zone <IANA zone>` and `jobs alerts set tier1 <true|false>`
  change one field each. They are checked by the same parser as the env values (the parsing moves
  into shared functions), and a bad value is refused with nothing stored.
- `jobs alerts reset <quiet|zone|tier1>` puts one field back to its default (null).

## Acceptance criteria
- [ ] Setting a field stores a version and an `alerts.settings_changed` event; setting the same
      value again stores nothing (test, PGlite).
- [ ] The table refuses UPDATE and DELETE (append-only trigger test), and its CHECKs refuse
      out-of-range minutes, equal start and end, or only one of start and end.
- [ ] `effectiveAlertConfig` takes each stored field and falls back to the default per field
      (tests).
- [ ] An alert pass uses the stored quiet hours over the env default (test).
- [ ] The CLI refuses a bad value with nothing stored and prints the source of each value (tests).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` green; evals unchanged.

## Failure modes
- The database read fails: the alert pass fails as a database read fails today (the span is
  marked, the scoring pass's own counts aren't lost).
- A stored time zone the runtime no longer knows: the effective config falls back to the default
  zone and reports `zone: default (stored zone unknown)`, so alerts keep working.

## Observability
- `alerts.settings_changed` event (field names only) with its feed line.
- The `sources.fresh_alerts` span gets `alerts.settings_source` (`default`, `stored` or `mixed`).

## Out of scope
- The Settings → Search page in the web app (the next slice).
- Item 1, the phone push.

## Decisions made without Paul
- A separate table rather than new `search_preference` columns: the preference version is part
  of every Fit Score's key, so a quiet-hours change there would re-score every ready job.
- Null fields mean "use the `ALERT_*` default", so `.env` stays the default as the issue asks.

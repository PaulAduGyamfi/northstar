# NS-199 slice 3: the fresh-job alert settings on Settings → Search

Status: in progress (autonomous lane, ADR-0016)
Issue: #172, item 2 (the in-app page; storage and `jobs alerts` merged in slice 2, #334)
Requirements: SRC-015 (quiet hours, tier-1 rule "configurable"), SRC-017 (search settings
editable any time in Settings → Search), UX-020 (state in words)
Rules that apply: ADR-0002 (a setting change is Paul's, session only), ADR-0016, ADR-0018,
`.claude/rules/web.md`, `.claude/rules/tests.md`

## Why
Slice 2 stored quiet hours, their time zone and the tier-1 rule, but Paul can change them only
with `jobs alerts set …` in a terminal. SRC-017 puts search settings in the app.

## Behavior
- `alertChange(field, raw)` (`packages/sources`, `alerts-cli.ts`, today's private `changeOf`,
  exported) turns one field word (`quiet`, `zone`, `tier1`) and its text into a stored change,
  or null when the text is bad. The CLI and the API use the same function, so the page can store
  nothing the CLI would refuse. `alertSettingsView(defaults, stored)` gives the effective values
  as text (`HH:MM-HH:MM` or `off`, the zone, yes/no) and each one's source.
- The API (`apps/api/src/alert-settings.ts`, session only):
  - `GET /settings/alerts` answers the effective quiet hours, zone and tier-1 rule, each with
    `stored` or `default`, and `unknownStoredZone`.
  - `POST /settings/alerts` takes `{ field, value }` (`value` null puts the field back to its
    default), checks it with `alertChange` (`400 invalid_value`, nothing stored), stores it with
    `setAlertSettings` and answers the new view and whether anything was saved. The body can't
    name who changed it.
  - A failed read or write is `503 unavailable`. Bad `ALERT_*` defaults don't stop the API: both
    routes answer `503 alert_defaults_invalid` naming no value.
- The web app's `/settings/search` (`src/search-settings.ts`, `app/settings/search/`) shows the
  three settings in words, each marked "set here" or "default", with a form per setting
  (quiet hours as two time inputs or off, the zone as text, tier-1 as yes/no), a Save and a
  "Use the default" button, and says what the API answered. Linked from Today beside
  Settings → Accounts. No new nav tab (the five tabs are fixed).

## Acceptance criteria
- [ ] `alertChange` refuses what the CLI refused, and the CLI still behaves the same (tests).
- [ ] The API reads the view, stores a change, refuses a bad value with nothing stored, resets a
      field, needs a session, and answers 503 on a failed read or bad defaults (tests).
- [ ] The page's plain functions word each setting and its source, and build each request body
      (tests).
- [ ] lint, typecheck, test, build green in `packages/sources`, `apps/api`, `apps/web` (CI
      `checks`: this container's Node 22 can't install the workspace, which pins Node 24).

## Tasks
1. Export `alertChange` and `alertSettingsView` from `packages/sources`; CLI uses them.
2. `alert-settings.ts` endpoints with tests; wire in `bin.ts`.
3. `src/search-settings.ts` with tests; the page and its form; a link on Today.
4. AGENTS.md lines for the API and the page.

## Out of scope
- Item 1 (phone push): it needs the PWA's notification channel.
- The other search preferences (titles, pay, …) on this page: still `jobs prefs set`.

## Failure modes
- API down: the page says so and shows nothing else, as the other pages do.
- A stored zone this machine doesn't know: the page says the default zone is used.

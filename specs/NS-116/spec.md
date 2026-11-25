# NS-116: Fit scoring with evidence, live preferences

Status: agent-approved under ADR-0016 (autonomous lane; Paul reviews after the fact)
Requirements: MAT-001, MAT-002, MAT-003, SRC-017 (the CLI half; the Settings screen arrives with
the web app)
Rules that apply: ADR-0004 (provenance), ADR-0006 (LLM strategy), ADR-0012 (append-only events),
ADR-0015 (plain scheduler), ADR-0016, `.claude/rules/db.md`, `gateways.md`, `llm.md`, `tests.md`

## Why
NS-114 and NS-115 bring jobs in, freshest first, but every job looks the same: Paul can't tell
which ones he's a fit for or why. This ticket gives every ready job a Fit Score from 0 to 100
with the evidence behind it (which of his experience atoms meets which requirement, and which
requirements nothing meets), sorts the queue by freshness × fit, and makes the search
preferences a setting Paul can change at any time, with every open job re-scored at once.

## Behavior

### Search preferences (SRC-017)
- `jobs prefs` shows the current preferences and their version.
- `jobs prefs set <field> <value>` changes one field. Fields: `titles`, `seniority`,
  `locations`, `remote` (any of `onsite`, `hybrid`, `remote`), `dealbreakers` (comma-separated
  lists), `compFloor`, `compTarget` (whole numbers per year), `currency` (three letters, default
  USD), `queueAt` and `suggestAt` (the MAT-003 thresholds A and B, 0–100, defaults 80 and 60).
  `-` clears a field.
- Each change stores a **new version**; old versions are kept (history for SRC-018). Setting a
  field to the value it already has stores nothing.
- A change re-scores every ready job right away (no restart) and records
  `preferences.changed` (field names, old and new version) and `preferences.rescored` (how many
  jobs, how many per band). The CLI prints "Preferences changed: compFloor 150000 → 170000;
  14 jobs re-scored."
- Company tiers stay on the watchlist (`jobs watch add --tier`, NS-115).

### Fit Score (MAT-001)
Plain code, no model (decision below). For each ready job, with the current preferences and the
current resume import:
- **Title fit** (0–1): 1 when the job title contains one of Paul's target titles, 0.5 when it
  shares a significant word with one, else 0; halved when the job names a level (junior,
  senior, staff, principal, lead…) that isn't in Paul's `seniority` list. Unknown with no target
  titles.
- **Must-have coverage**: matched requirements ÷ all requirements. Unknown when the posting lists
  none.
- **Nice-to-have coverage**: the same over nice-to-haves.
- **Preference fit**: the average of the checks the posting lets us make: pay (top of the range
  at or above the floor; yearly, or monthly × 12, or hourly × 2,080, same currency) and place
  (its remote policy is one Paul accepts, or its location contains one of his locations). Company
  stage isn't known for any job yet and isn't scored.
- **Score** = 100 × weighted mean of the known components (title 25, must-haves 40,
  nice-to-haves 10, preferences 25), rounded. Unknown components are left out, never guessed as
  0 or 1, and shown as "unknown".
- **Stretch** flag: Paul meets at least half but less than three quarters of the must-haves.

### Evidence (MAT-002)
- A requirement is **matched** by an experience atom when a technology the atom names (its `how`
  list, or a skill from his resume that the atom's own text names) appears in the requirement as
  a whole word ("Go" isn't found in "Google", "C" isn't found in "C#"). The first such atom in
  resume order is cited, with the term that matched.
- Everything else is **unmatched**, listed as such. Requirements about years, degrees or soft
  skills are unmatched by this rule even when Paul has them: a known limit, fixed by the
  model-assisted matcher follow-up.
- `jobs why <job-id>` prints the score, band and reason, each component, every matched
  requirement with its atom id, term and the atom's text, every unmatched requirement, and the
  pay and place checks.

### Bands (MAT-003)
- A job that names a dealbreaker (whole phrase, in its title, description, requirements or
  nice-to-haves) is **skip**, reason `dealbreaker`.
- A job whose pay is known and below the comp floor is **skip**, reason `below_comp_floor`.
- A job with no known component at all (no target titles, no requirements, no pay or place to
  check) is **suggest**, reason `no_evidence`, stored with score 50 (the column needs a number),
  so Paul looks at it instead of it being skipped on nothing. `jobs list` shows it as
  `fit ? suggest (no_evidence)` and orders it by freshness alone, like an unscored job.
- Otherwise score ≥ `queueAt` → **queue**; ≥ `suggestAt` → **suggest**; below → **skip**, reason
  `below_threshold:<weakest component>`.
- The band and reason are stored with the score and logged as a `job.scored` event. Skipped jobs
  stay in `jobs list`, marked with their reason.

### When scoring runs
- A score is keyed by the job's scoring fields (a fingerprint), the preference version and the
  resume import. `scorePending` scores every ready job with no score for the current key, so:
  after `jobs add`, after every `jobs poll` pass (and `jobs run` tick), after `jobs set`
  (Paul's edit changes the fingerprint), after `jobs prefs set`, and on `jobs score`.
- Scoring needs a resume import and a preference version; without either, it scores nothing and
  says what's missing.
- Scoring the same job with the same key twice stores one score (unique key; safe to repeat).

### Queue order (SRC-013, the fit half)
- `jobs list` orders by `queueScore(freshness, fit / 100)` (the NS-115 function, unchanged), and
  shows each job's fit and band. A job with no score yet keeps freshness alone, as before.

## Acceptance criteria
- [ ] `jobs prefs set` parses every field and refuses bad values with the field's name (tests).
- [ ] Each change stores a new version; the same value twice stores nothing (db tests).
- [ ] Changing the comp floor re-scores open jobs in the same command and records
      `preferences.changed` and `preferences.rescored` with the count (test, SRC-017 acceptance).
- [ ] A requirement naming a technology from an atom's `how` is matched to that atom with the
      term; "Go" isn't matched by "Google" (tests).
- [ ] The score, components, stretch flag and band follow the rules above for fixed synthetic
      jobs (tests, exact values).
- [ ] A dealbreaker or below-floor pay is a skip with that reason; an unknown pay is not (tests).
- [ ] Scoring twice with the same key stores one score; editing the job or the preferences
      stores a new one (db tests).
- [ ] `jobs list` puts a fresh 82-fit job above a 5-day-old 90-fit one (SRC-013 acceptance), and
      shows fit and band (test).
- [ ] `jobs why` prints every matched and unmatched requirement (test).
- [ ] Events carry ids, versions, numbers, bands, reason codes and field names; never a title,
      company, requirement, atom text or preference value (test).
- [ ] Span `fit.score` per pass with counts (test).
- [ ] `pnpm turbo run lint typecheck test build` and `eval --all` pass.

## Failure modes
- **No resume imported or no preferences yet:** nothing is scored; `jobs list` prints the job as
  before NS-116 (no fit suffix) and `jobs score` names the missing step. Ingest and polling are unaffected.
- **One job fails to score** (a database error on its insert): counted as failed in the pass (its
  error name on the span) and retried next pass (it's still pending); other jobs score.
- **Scoring throws during `jobs prefs set`:** the new version is already stored; the command says
  scoring didn't run and to run `jobs score`.
- **Database down:** the command fails before anything; nothing is half-written (each job's
  score and event are one transaction; a preference version and its event are one transaction).
- **A preference change while `jobs run` is scoring:** both passes compute the same key; the
  unique constraint keeps one score per key.

## Observability
- Events: `preferences.changed`, `preferences.rescored` (aggregate `search_preference:<id>`),
  `job.scored` (aggregate `job:<id>`: score, band, reason code, stretch, preference version,
  method `rules`).
- Span: `fit.score` per pass (`fit.jobs`, `fit.queue`, `fit.suggest`, `fit.skip`, `fit.failed`).

## Out of scope
- **Model-assisted matching** (a `job-match` route reading requirements like "5+ years" or
  "strong communication"): agent-filed follow-up. Rule matching is the deterministic floor it
  builds on, and its provenance check reuses this evidence shape.
- **Settings → Search in the web app (UX-017)** and the feed line on screen (NS-125): the web app
  doesn't exist yet. The CLI is the setting surface; the events are what the feed will render.
- **Calibration from overrides and outcomes (MAT-004)**, skill-gap signals (MAT-005), company
  stage.
- **Auto-queue doing anything:** the band is stored; the Approval Gate (NS-119) consumes it.

## Open questions (decided under ADR-0016, recorded in the PR)
1. Rules, not a model, for this slice: free, deterministic, testable without fixtures, and Code
   decides (AGENTS.md). The cost model's Opus scoring becomes the follow-up.
2. Weights (25/40/10/25), stretch (50–75 % of must-haves), comp floor as a hard skip, defaults
   A = 80 and B = 60 are mine.
3. Two new tables (`search_preference`, `fit_score`) and migration 0015.

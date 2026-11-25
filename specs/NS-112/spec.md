# NS-112: Employment-facts consistency (official HR dates everywhere)

Status: approved by Paul (he pre-approved every step of NS-112 in chat on 2026-11-25, before the
spec was written; he reviews it on the PR)
Requirements: DX-011, CPG-004 (locked facts), H11 in 13-search-diagnostics
Rules that apply: ADR-0004 (no fabrication), ADR-0012 (events), `.claude/rules/db.md`,
`.claude/rules/tests.md`

## Why
Paul's employment dates must say the same thing everywhere. A resume, LinkedIn or application form
that disagrees with his employer's records (most of all the Mastercard end date) can fail a
background check late in the process, and the mismatch itself reads worse than the layoff does
(13-search-diagnostics, "A specific risk to check right away"). DX-011 asks for one source of
truth, the official HR record, and a check of every other place against it.

## Behavior
- **Official record.** Paul writes his official employment facts in a plain-text file under
  `data/` (gitignored), one position per line: `Employer | Title | start | end`. Dates are
  `YYYY-MM` or `YYYY-MM-DD` (the date HR's records show); `end` is `present` for an ongoing
  position. Lines that are blank or start with `#` are ignored.
- `profile facts set <file>` stores that record as the single source of truth (table
  `employment_fact`). It replaces the previous record in one transaction: the old rows are kept
  and marked superseded. Setting the same record again changes nothing.
- `profile facts check` compares the current resume's roles (from the profile graph, NS-110)
  with the official record and prints each mismatch, then a count. It exits 1 when there is any
  mismatch, 0 when everything agrees.
- **What counts as a mismatch,** decided by plain code (`checkEmploymentFacts`), never a model:
  - `employer`: the claimed employer isn't in the official record.
  - `title`: the employer is there, but not with that title.
  - `start` / `end`: the dates disagree. Dates are compared at the precision both have, so a
    resume's `2021` or `2021-06` agrees with an official `2021-06-14`. A date the claim leaves out
    is not a mismatch.
  - `current`: one side says the position is ongoing and the other doesn't, e.g. a resume that
    still says "present" for a job the official record ended, or the reverse.
- When the record has two rows for the same employer and title (a rehire), a claim is compared
  with the stint whose start agrees with it.
- Names are compared in any script: accents are dropped and non-Latin letters kept. A name with
  no letters or digits never matches. The database allows only one active record at a time.
- Employer names are compared without case, punctuation or a trailing company suffix (`Inc`,
  `LLC`, `Ltd`, `Corp`, `Corporation`, `Co`, `PLC`). Titles are compared without case or
  punctuation, with `Sr`/`Jr`/`Mgr` read as `Senior`/`Junior`/`Manager`.
- The checker takes claims from any source: `resume`, `linkedin`, `site` or `application_form`.
  Only the resume is wired up in this ticket. `blocksAutoSubmit(mismatches)` is true when any
  mismatch comes from an application form; the Apply Gateway (NS-120) calls it before submitting.
- Every `facts set` and `facts check` writes a domain event with counts only (no employers,
  titles or dates), so the feed and a later Today view can show the latest result.

## Acceptance criteria
- [ ] A resume role whose end date differs from the official end date is reported as an `end`
      mismatch with both values (test).
- [ ] A resume role marked current for a job the official record ended is reported as a
      `current` mismatch (test).
- [ ] `2021` and `2021-06` agree with an official `2021-06-14`; `2021-07` doesn't (test).
- [ ] `Mastercard Inc.` matches `Mastercard`; `Sr. Software Engineer` matches
      `Senior Software Engineer` (test).
- [ ] DX-011's criterion, at the checker level: an `application_form` claim with an end date that
      differs from the official one makes `blocksAutoSubmit` true; a resume mismatch alone doesn't
      (test). Wiring it into the submit path is NS-120.
- [ ] A record line with a bad date, a missing field or an end before its start is refused with
      its line number, and nothing is stored (test).
- [ ] `setEmploymentFacts` twice with the same record stores one record and one event; a
      different record supersedes the old rows instead of deleting them (PGlite test).
- [ ] The database refuses a position whose `is_current` and `end_date` disagree, and a date in
      the wrong format (PGlite test).
- [ ] The `facts.set` and `facts.checked` events hold counts only: no employer, title or date
      (tests).
- [ ] `profile facts check` with no official record says how to add one and exits 1 (test).
- [ ] `pnpm turbo run lint typecheck test build` passes for `@northstar/db` and
      `@northstar/profile`.

## Failure modes
- **No official record yet:** `facts check` says to run `facts set` first and exits 1. It never
  treats the resume as the source of truth.
- **No resume imported:** `facts check` says to import one and exits 1.
- **Database down:** the CLI fails before reading anything, with the same safe error summary as the
  other `profile` commands (no row values printed).
- **Bad record file:** nothing is stored; each bad line is listed by number with what's wrong,
  never echoing other lines.

## Observability
- `profile.facts_set` event: `{ positions }` count, actor `user`. Setting an unchanged record
  writes no event.
- `profile.facts_checked` event: `{ claims, mismatches, byField, bySource }` counts, actor
  `user`. No values: employers, titles and dates stay in their tables.
- No spans: these are local CLI commands with no model or network call. The Apply Gateway's check
  (NS-120) will run inside its own span.

## Out of scope
- The red item on the Today view: there is no web app yet. The `profile.facts_checked` event is
  what the Today view reads when it lands.
- Reading LinkedIn (PRF-002, browser extension) and Paul's site: the checker already accepts those
  sources; feeding them is a later ticket.
- Calling the check from the Apply Gateway and raising `needs_human`: NS-120.
- Editing the resume's locked roles to match: Paul fixes the resume itself, then re-imports.
- Education dates: DX-011 is about employment.

## Open questions
- Q-14 is still open: Paul's official Mastercard end date. This ticket gives him the place to
  record it; it doesn't guess it.
- Inferred, not read: the record file format, the suffix and abbreviation lists, and that a date a
  claim omits isn't a mismatch.

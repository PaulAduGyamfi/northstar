# NS-133: Profile: import LinkedIn export (slice 1 of LinkedIn, GitHub, personal site)

Status: accepted (autonomous lane, ADR-0016)
Requirements: CPG-001, CPG-004, DX-011 · ADR-0004
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/db.md`, `.claude/rules/llm.md`, `.claude/rules/tests.md`

## Why
The profile graph only knows Paul's resume. CPG-001 also names his LinkedIn data export (the
official "Get a copy of your data" archive, never scraping). Importing it gives the profile a
second source, and lets `profile facts check` compare LinkedIn's employers, titles and dates
with his official HR record (DX-011), which the check was built to do "later".

## Behavior
1. **Parse** (`packages/profile/src/linkedin.ts`, plain code, no model): from the export folder
   Paul unzipped into `data/`, read `Positions.csv` (required), `Education.csv` and `Skills.csv`
   (optional) with an RFC 4180 CSV reader (quoted fields, embedded commas and newlines).
   - Columns are found by header name, so column order doesn't matter. A missing required header
     refuses the import and names the file and header.
   - Positions → roles (Company Name, Title, Started On, Finished On; no Finished On means
     current). Dates "Mar 2021" → `2021-03`, "2021" → `2021`; anything else is stored as not
     stated (null), never guessed.
   - Each non-empty line of a position's Description (bullet marks stripped) → one experience
     atom for that role, its `sourceQuote` the line verbatim.
   - Education → education rows (School Name, Degree Name, Start Date, End Date). Skills → skills.
2. **Provenance:** every atom's quote must appear verbatim in its position's Description, and
   every role's employer and title must be its row's fields (a deterministic check, as for the
   resume). A failing export stores nothing.
3. **Store** (`packages/db`): `profile_source.kind` may be `linkedin` (one migration). The
   existing import path takes a `kind`; re-importing the same files is a no-op, a changed export
   supersedes the current LinkedIn source only. Every reader that means "the resume" already
   filters `kind = 'resume'`; thesis saving now does too (it only checked "current").
   The `profile.imported` event carries `kind`, and its feed line names LinkedIn.
4. **CLI:** `profile import-linkedin data/<folder>` prints counts only (Paul only: his real data).
5. **Facts check:** `profile facts check` also compares the current LinkedIn import's roles
   (source "LinkedIn") with the official record.

## Acceptance criteria
- [ ] A synthetic export with quoted, multi-line descriptions parses into roles, atoms, education
      and skills; columns in another order give the same result.
- [ ] A missing `Positions.csv` or required header refuses the import with its name.
- [ ] "Mar 2021" → `2021-03`, "2021" → `2021`, anything else → null.
- [ ] Re-importing the same export is a no-op; a LinkedIn import never supersedes the resume.
- [ ] Resume readers (profile view, scoring, stories, thesis) ignore LinkedIn rows; a thesis
      citing a LinkedIn atom is refused.
- [ ] `facts check` reports a LinkedIn date that disagrees with the official record.

## Failure modes
- A malformed CSV (unclosed quote) refuses the whole import with the file name; nothing is stored.
- LinkedIn changes its export headers: refused by header name, so Paul sees which one.

## Observability
`profile.imported` with `kind: "linkedin"` and counts only (never text), feed line "Imported your
LinkedIn export into the profile graph".

## Out of scope (follow-up issue)
- GitHub repositories and the personal site, each its own slice.
- The merge step that reconciles duplicates across sources and keeps Paul's locked-fact edits.
- Using LinkedIn atoms for scoring, tailoring or stories (they stay a separate source for now).

## Open questions
- Header names and date formats are from LinkedIn's documented export (no real export is read
  here; the repo is public). If Paul's export differs, the import refuses by header name.
- No eval set: nothing in this slice calls a model.

# NS-196: Gap-to-proof: independent-work entries and the 20-second answer (slice 1)

Status: accepted (autonomous lane, ADR-0016)
Requirements: DX-010 (gap-to-proof narrative), DX-011 (official dates)
Rules that apply: ADR-0004 (provenance), ADR-0012, `.claude/rules/db.md`,
`.claude/rules/tests.md`
Parent: #95

## Why
DX-010: show the months since Paul's last role as proof of work, as a "Projects / Independent
work" resume section and a 20-second spoken answer to "what have you been doing since?", under the
provenance rules. Nothing stores that work yet, so nothing can cite it.

## Behavior
1. **packages/profile** (`independent-work.ts`, plain code, no model):
   - `parseIndependentWork(text)` reads Paul's file, one block per entry. The header is
     `Title | YYYY-MM | YYYY-MM or present [| https link]`, then 1–6 lines starting `- `, each his
     own words. A title is at most 80 characters and a line at most 200, one line each. The end
     is not before the start. A file with any bad line returns every problem and nothing else.
   - `independentWorkSection(entries)`: the section's lines, ongoing and newest first: a heading,
     then `Title (Mon YYYY – present)` and each line verbatim.
   - `twentySecondAnswer(entries, since)`: at most 55 words (about 20 seconds spoken), built only
     from the entries' titles and lines and, when the official record has ended, the last
     employer and month. Its `sources` say which entry and line each part came from. It drops
     later titles, then the example line, to fit; with no entries it says there's nothing yet.
     `sinceFromFacts(positions)` picks the latest ended position when none is ongoing.
2. **packages/db** (one migration, append-only by triggers):
   `independent_work_set` (a version per stored file, with its SHA-256), `independent_work_entry`
   and `independent_work_line`. `setIndependentWork` stores a new version in one transaction;
   the same content stores nothing. `readIndependentWork` returns the newest version.
   `independent_work.set` carries the version and counts only, never a title, line or link.
3. **CLI:** `profile work set data/<file>` (prints counts) and `profile work show` (the section,
   the 20-second answer and its sources). Paul only: it is his data.

## Acceptance criteria
- [ ] A good file parses into entries; a bad header, date, link, overlong or multi-line field,
      an entry with no lines or more than 6, and an end before its start each give a problem
      naming the line, and nothing is stored.
- [ ] The section and the answer use only words from the entries, their titles and the official
      record; the answer stays within 55 words and names its sources.
- [ ] Setting the same file twice stores one version; a changed file stores the next one; old
      versions stay; the event carries no text.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
A bad file stores nothing and prints each problem with its line number. No database: the command
fails with its usual message and stores nothing.

## Observability
`independent_work.set` (version, entries, lines) in the feed; the write's span carries counts.

## Out of scope
- Putting the section into tailored resumes and the PDF, LinkedIn entries, and feeding the thesis
  into the summary, headline, pitch and outreach (as each lands).
- Any model drafting: the lines are Paul's own words.

## Decisions made without Paul (ADR-0016)
- **Provenance for independent work:** there is no resume line to quote, so an entry's lines are
  Paul's own statements, stored as he wrote them, and everything shown cites an entry and line.
- **A file per version, like `profile facts set`:** one command to add, edit or remove entries;
  history stays.
- **The 20-second answer is a plain-code template** (55 words), not a model draft.
- **Schema change:** one migration with three append-only tables.

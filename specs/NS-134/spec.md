# NS-134: Profile: handle two-column PDF resumes

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: CPG-001 (resume import, TXT/MD/DOCX/PDF). GitHub issue #43.
Rules that apply: ADR-0004 (every atom quotes the resume verbatim), ADR-0013 (request-keyed
replay fixtures), AGENTS.md (public repo, synthetic fixtures; `--record`/`--live` evals are
Paul's), ADR-0016 item 8, `.claude/rules/tests.md`.

## Why
pdf.js reads a two-column PDF across the page, so a left-column bullet is interleaved with the
right column's skills or certifications. The model then quotes a bullet that no longer appears
verbatim in the extracted text, the provenance check refuses it, and the import fails (safe, but
the resume can't be imported). The `two-column-pdf` eval case pins this and fails by design
(baseline 7/8).

## Behavior
1. **Column-aware PDF reading** (`packages/profile/src/pdf-layout.ts`, plain code). For each page,
   `fileToText` reads pdf.js's text items with their positions (x, y, width) and passes them to
   `pageText(items, pageWidth)`:
   - **Lines.** Items whose baselines are within 2 points are one line, read left to right. A
     space goes between two pieces only where there is a visible gap and neither has one already.
   - **Gutter.** Each item's left edge between 25% and 75% of the page width is a candidate x.
     A candidate qualifies when:
     - at least 3 lines have text wholly left of it, and at least 3 wholly right of it;
     - at most 25% of the page's lines cross it (an item starts left of it and ends right of it);
     - at least 3 lines' right-hand text starts at x (within 2 points), and at least one of those
       lines has nothing on its left. This is what separates a real sidebar from right-aligned
       dates or a centred heading: a dated entry always has text on its left.
     The candidate with the fewest crossing lines wins; ties go to the leftmost.
   - **Bands.** Lines that cross the gutter (a name or a rule across the page) stay where they
     are and split the page into bands. Each band emits its left column's lines, then its right
     column's. Blocks (a crossing line, a band's column) are separated by a blank line.
   - **No gutter: unchanged.** `pageText` returns null and the page's text comes from unpdf's
     `extractText` exactly as before. Single-column PDFs read byte for byte as they do today, so
     no other import or recorded fixture changes.
2. **Pages** are still joined by a blank line.
3. **The eval.** The `two-column-pdf` case's input is text, not a PDF: it is the interleaved text
   pdf.js used to produce. Making it pass means:
   - replacing that input with the column-aware reading;
   - recording a new fixture (`--record`, which calls the API);
   - moving the baseline to 8/8 (`--update-baseline`).

   Those are Paul's steps (ADR-0016 items 5 and 8: an eval-set change, `--record` and a baseline
   change), so this ticket leaves `evals/` untouched. It opens a `needs:paul` issue that gives the
   exact replacement text, which the new test produces from a synthetic PDF with the same content.

## Acceptance criteria
- [ ] A synthetic two-column PDF with the eval case's content (experience on the left, skills and
      certifications on the right) reads as the whole left column, then the whole right column,
      with each bullet's wrapped lines next to each other, and a wrapped bullet is quotable
      verbatim after `normalize` (profile tests).
- [ ] A line crossing the gutter stays in place and splits the page into bands (unit test).
- [ ] The single-column `sample.pdf` reads exactly as `extractText` read it (an exact-string test).
- [ ] `pageText` returns null for one column, a gutter outside 25–75% of the width, a side with
      fewer than 3 lines, an indented single column, right-hand text that always shares its line
      with left-hand text, and right-aligned dates on an A4 page (unit tests on synthetic items).
- [ ] The `two-column-pdf` eval is unchanged and still replays at 7/8 (`eval --all`).
- [ ] A `needs:paul` issue asks Paul to replace the case's input, re-record and set the baseline
      to 8/8.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Three or more columns, or a sidebar that changes width:** no single gutter qualifies, so the
  page reads as today and the provenance check refuses quotes it can't find. Nothing wrong is
  written.
- **A false gutter in a single-column page** would separate text that belongs on one line, for
  example a role from its dates (locked facts, CPG-004). The gutter rules require a right column
  with its own aligned lines, at least one standing alone, which right-aligned dates and centred
  headings don't have. When in doubt the page reads as today.
- **A real sidebar laid out exactly in step with the left column** (every right line shares a
  baseline with left text) isn't recognised and reads as today: the safe direction.
- **pdf.js returns no positions** (an unusual PDF): `pageText` gets no items and returns null,
  so the old path runs.

## Observability
No new events. The import's existing counts and spans are unchanged.

## Out of scope
- Asking Paul for a DOCX when a layout is multi-column (the issue's second option). Not needed
  once two columns read correctly.
- Three-column layouts.
- Editing `evals/profile-extract` (Paul's step, above).

## Open questions
- None from the issue. The 25–75% band and the 3-line minimum are choices, recorded here.

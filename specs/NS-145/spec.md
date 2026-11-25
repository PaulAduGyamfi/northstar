# NS-145: Render tailored resumes to PDF and DOCX and re-parse the PDF

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: TLR-004 (the pre-send ATS check re-parses the rendered PDF: at least 95% of the text
and every section header recovered), TLR-005 (render to clean ATS-safe PDF and DOCX from one
template), TLR-001 (keep to one page, configurable). GitHub issue #84, parent #16 (NS-117).
Rules that apply: ADR-0004 (locked facts come from the master), AGENTS.md (dependencies: exact
version, release at least 14 days old, an ADR), ADR-0016 item 4 (a dependency is decided and
recorded), `.claude/rules/tests.md`.

## Why
NS-117 renders a tailored resume to plain text only, and its ATS check reads that text back from
itself. Applications need a PDF (and some forms a DOCX), and TLR-004 asks that the check read back
the real PDF with our own parser, the way an ATS would.

## Behavior
All in `packages/profile/src/tailor/`.
1. **One template.** Both renderers lay out the lines of `renderResumeText`, so the headers, the
   order, the bullets and the locked facts (employer, title, school, dates from the master) are
   the same in all three formats.
2. **`renderResumePdf(resume, master)`** (`pdf.ts`, pdf-lib):
   - US Letter, 0.75-inch margins, one column.
   - Helvetica (a standard PDF font, so nothing is embedded): headers bold at 11 pt, everything
     else 10 pt. Long lines wrap at word boundaries.
   - Returns the bytes and the page count. A character Helvetica can't encode becomes "?", which
     the re-parse check then counts as a missed word, so it is visible rather than silent.
3. **`renderResumeDocx(resume, master)`** (`docx.ts`, docx): the same lines as plain paragraphs
   (headers bold, bullets as "- " text, no tables, columns or numbering) in a single section.
4. **Page budget (TLR-001):** `tailorToPages(master, job, { maxPages = 1 })` measures the
   rendered page instead of trusting `maxLines`.
   - It returns the largest line budget whose PDF fits `maxPages`, never below one line, with the
     resume and its PDF.
   - Fewer lines never take more pages, because the tailor drops its least relevant line first
     and the paginator only moves forward. So a binary search over `maxLines` finds that budget
     in about log2(atoms) + 2 renders, instead of one render per line.
   - Long words are cut to the line width rather than running past the margin.
5. **Re-parse (TLR-004):**
   - `pdfToText(bytes)` (`text.ts`) is the same unpdf reading `fileToText` uses for a PDF file,
     column-aware pages included (NS-134). `fileToText` now calls it.
     - It copies the bytes first, because pdf.js detaches the buffer it reads and would leave
       the caller's PDF empty.
     - It refuses more than 10 MB, the same cap as `fileToText`.
   - `preSendScoreFromPdf({ master, job, resume, pdf })` passes the text read back from the PDF
     to `atsParseCheck`.
6. **Dependencies:** `pdf-lib@1.17.1` and `docx@9.15.3`, exact versions, both released more than
   14 days ago, MIT, in `packages/profile` only. Recorded in ADR-0020.

## Acceptance criteria
- [ ] The synthetic master renders to a one-page PDF whose re-parsed text recovers at least 95%
      of the words and every header (`preSendScoreFromPdf(...).ats.pass`) (profile tests).
- [ ] The DOCX for the same resume reads back (mammoth) with every header and bullet line.
- [ ] A long synthetic master (many atoms) renders to more than one page with all its lines, and
      `tailorToPages` brings it to one page by dropping the least relevant lines. `maxPages: 2`
      keeps more lines.
- [ ] Employer, title and dates in the PDF come from the master, whatever the tailored resume
      holds.
- [ ] A character Helvetica can't encode doesn't throw; it is replaced.
- [ ] ADR-0020 written; `pnpm-lock.yaml` updated by pnpm only.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **An unencodable character** (an emoji, a non-Latin name): it is replaced with "?" and lowers the
  re-parse score, so the pre-send check flags it. Embedding a Unicode font is a follow-up if
  Paul's material needs one.
- **A resume that can't fit even with one line** (a very long education list): `tailorToPages`
  returns the one-line version and its page count, and the caller sees `pages > maxPages`.
- No I/O: the renderers return bytes, and nothing is stored here (NS-146 stores them).

## Observability
None new here. NS-146's `resume.tailored` event will carry the page count and the re-parse score.

## Out of scope
Storing the files (NS-146), a Unicode font, and styling beyond the ATS-safe template.

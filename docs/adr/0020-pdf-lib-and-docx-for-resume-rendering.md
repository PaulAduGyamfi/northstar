# ADR-0020 — pdf-lib and docx for rendering tailored resumes

**Status:** Accepted (agent, under ADR-0016) · **Date:** 2026-11-25

## Context
TLR-005 asks for clean, ATS-safe PDF and DOCX resumes from one template. TLR-004 asks that the
pre-send check re-parse the rendered PDF with our own reader. NS-117 rendered plain text only. A
PDF writer and a DOCX writer are new dependencies, which AGENTS.md says need an exact version on a
release at least 14 days old, and ADR-0016 item 4 says an agent records the choice here.

## Decision
- **PDF: `pdf-lib@1.17.1`** (MIT, pure TypeScript, no native code, no network, last release
  2021).
  - It writes text with the standard Helvetica font, so nothing is embedded and the text stays
    extractable.
  - It gives exact text widths, so lines are wrapped and the page is measured in code (TLR-001's
    one page).
- **DOCX: `docx@9.15.3`** (MIT, pure TypeScript, released 2026-11-06).
  - It writes plain paragraphs with no tables or columns.
  - 9.16.0 was only 6 days old, so the newest release outside the 14-day cooldown is pinned.
- Both are used in `packages/profile` only (`tailor/pdf.ts`, `tailor/docx.ts`). The renderers
  lay out the lines of `renderResumeText`, so all three formats share one template.
- Reading the PDF back uses the existing `unpdf` (NS-110), so the check reads the resume the way
  the profile import does.

## Alternatives considered
- **Headless Chromium printing HTML to PDF** (Playwright is planned for the Apply Gateway): best
  typography, but it needs a browser in the render path, more memory and a sandbox. That is too
  much for one page of text.
- **pdfkit:** a capable writer, but it is stream-based and depends on Node built-ins. pdf-lib's
  plain `Uint8Array` output is simpler to test.
- **Writing the DOCX XML by hand** (as the NS-110 test fixtures do): no dependency, but every
  edge (escaping, styles, the zip) becomes our code to maintain.

## Consequences
- **Plus:** no native code or browser, and tests render real PDFs and DOCX files in memory.
- **Minus:**
  - Helvetica covers Latin text only (WinAnsi). A character it can't encode is replaced, and the
    re-parse check then reports it. A name in another script needs an embedded Unicode font, a
    follow-up with its own dependency choice.
  - Two more packages and their small transitive set (pako, tslib, fflate, nanoid, the pdf-lib
    font metrics) to keep current through Dependabot.

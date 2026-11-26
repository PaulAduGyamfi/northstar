# NS-231: The independent-work section in tailored resumes (slice 1)

Status: built (autonomous lane, ADR-0016)
Requirements: DX-010, DX-009, TLR-001, TLR-002, TLR-005
Rules that apply: ADR-0004 (no fabrication), ADR-0020 (PDF and DOCX), `.claude/rules/tests.md`.
Issue #245 (Parent: #167).

## Why
NS-196 stores Paul's independent work since his last role and can print the "Projects /
Independent work" section, but tailored resumes don't include it. The gap in his history goes
unexplained on exactly the documents that go out.

## Behavior
- **What the tailor reads.** `tailorForJob` reads the newest stored independent work through a
  new `readWork` dependency (the CLI wires `readIndependentWork`). It puts it on the master as
  `independentWork` (version and entries).
- **What the tailor adds.** `tailorResume` adds an `independentWork` section to the tailored
  resume:
  - every stored entry and line, verbatim, in the section's own order (ongoing first, then the
    latest; `ordered`);
  - each entry citing its stored position (`entry`) and each line its position (`line`) in that
    version.

  The job chooses or drops nothing: this is Paul's proof of the gap. With no stored work there is
  no section.
- **Rendering.** The section renders under the existing `PROJECTS` header, after any project
  atoms. Each entry is headed like a role (`Title · Jul 2025 – Present`), with its lines as `- `
  bullets. The PDF and DOCX lay out the same text lines, so all three renders carry it.
- **Validation.** `validateTailoredResume` refuses a section:
  - when no work is stored, or the section is from another version;
  - when an entry cites no stored entry, or its title or dates differ;
  - when a line isn't the stored line it cites, verbatim.

  Failures name positions only, never the text.
- **Page budget.** The section counts toward the one-page budget. `tailorToPages` measures the
  rendered PDF with the section in, so it drops atom lines rather than work lines.
- **Diff.** `diffResume` lists each added entry (`work`: stored position and line count), and the
  CLI prints them with their titles.

## Decisions (recorded in the PR under "Decisions made without Paul")
- **Under `PROJECTS`, not a new header.** `render.test.ts` asserts the header list exactly, so a
  new header would change an existing assertion (a hard stop). The section is projects anyway,
  and one projects header is what an ATS expects.
- **The model route is unchanged.** The section is added to the `TailoredResume` TypeScript type
  only. The Zod schema stays as it is: it is the `resume-tailor` route's output, so changing it
  would change every recorded request. Parsing drops unknown keys, so a model can't write a
  section. The section is also left out of what the route is sent, and the deterministic section
  is put back on a model resume that passed its checks.
- **The whole section is kept.** Atom lines give way to the page budget; Paul's work lines don't.
  A resume that can't fit even then still reports its page count, as before.
- **A third kind of citation.** TLR-002 and ADR-0004 say every line cites an experience atom
  or a story. Independent work has no resume line to quote, so NS-196 made Paul's own stored file
  its provenance. Here each work line cites its stored entry and line instead, checked verbatim by
  plain code. Paul may want ADR-0004 to name "stored independent-work line" as a citation.
- **Defence in depth on the model path.** Any section on a model resume fails validation (it has
  no stored work behind it), so the deterministic resume is used. A section on the model's output
  is also dropped before the deterministic one goes back on.
- **No migration.** `tailored_resume.resume` is JSON, and the section is stored inside it.

## Acceptance criteria
- [x] A tailored resume for a job includes the section, and its lines match the stored entries
      exactly.
- [x] The validator refuses a section line that isn't in the stored entries.
- [x] The page-budget test still passes with the section included, and the section's lines are
      in the PDF's text.
- [x] The model route never sees or writes the section. Its eval replays at baseline.
- [x] AGENTS.md says where the section appears.

## Out of scope
- LinkedIn "Projects" copy.
- Feeding the thesis into summaries, headlines and outreach.
- Links in the rendered section.

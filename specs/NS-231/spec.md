# NS-231: The independent-work section in tailored resumes (slice 1)

Status: draft (autonomous lane, ADR-0016)
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
- **No migration.** `tailored_resume.resume` is JSON, and the section is stored inside it.

## Acceptance criteria
- [ ] A tailored resume for a job includes the section, and its lines match the stored entries
      exactly.
- [ ] The validator refuses a section line that isn't in the stored entries.
- [ ] The page-budget test still passes with the section included, and the section's lines are
      in the PDF's text.
- [ ] The model route never sees or writes the section. Its eval replays at baseline.
- [ ] AGENTS.md says where the section appears.

## Out of scope
- LinkedIn "Projects" copy.
- Feeding the thesis into summaries, headlines and outreach.
- Links in the rendered section.

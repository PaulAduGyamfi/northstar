# NS-231 slice 2: LinkedIn "Projects" copy from the independent work

Status: draft (autonomous lane, ADR-0016)
Requirements: DX-010
Rules that apply: ADR-0003 (nothing writes to LinkedIn), ADR-0004, `.claude/rules/tests.md`.
Issue #245 (Parent: #167).

## Why
LinkedIn's Projects section should show the same independent work as Paul's resumes. Northstar
never writes to LinkedIn (ADR-0003), so Paul copies the text himself. It should be ready to
paste, field by field, and be his own words verbatim.

## Behavior
- **`linkedinProjects(entries)`** (`independent-work.ts`, plain code) gives one project per stored
  entry, in the section's own order (ongoing first, then the latest; `ordered`). Each project has:
  - LinkedIn's fields: the name (the title), the start month, and the end month or "currently
    working on this";
  - the link, when the entry has one;
  - a description: the entry's lines, verbatim, one per line, each starting with `• `.
- **The description limit.** A description longer than LinkedIn's 2,000-character limit is flagged
  `tooLong` with its length. It is never cut: Paul shortens his own file.
- **`profile work linkedin`** prints each project's fields under its number, for Paul to paste.
  - With no stored work it says so.
  - The command reads only Paul's stored work and prints to his own terminal: nothing is sent
    anywhere.

## Acceptance criteria
- [ ] Every entry becomes one project with its title, dates, link and verbatim lines, ongoing first.
- [ ] A description over 2,000 characters is flagged with its length and printed whole.
- [ ] `profile work linkedin` prints the fields, says so when nothing is stored, and the usage line
      lists it.
- [ ] AGENTS.md's commands table and the independent-work paragraph mention it.

## Out of scope
- Any LinkedIn API or browser automation (ADR-0003).
- The thesis surfaces.

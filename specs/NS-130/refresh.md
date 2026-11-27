# NS-130 slice 5: build the Career DNA report from the stored profile and save it

Status: in progress (autonomous lane, ADR-0016)
Requirements: DNA-008 (rebuilt when the profile changes), DNA-001…003
Rules that apply: ADR-0004, `.claude/rules/tests.md`.
Issue #54 (Paul's). Slices 1–4: #319, #321, #323, #327.

## Why
Slice 4 stores report versions, but nothing builds a report from Paul's stored profile. This slice
adds that step and a command Paul can run after an import or a new story.

## Behavior
- **`refreshCareerDna(deps)`** (`packages/profile`, `career-dna/store.ts`, plain code over ports):
  - reads the current resume import's atoms (`readScoringProfile`: id, what, how) and their imported
    quotes (`readThesisProfile`), and Paul's approved stories (`readStories`: id and competencies,
    unknown competencies dropped);
  - with no resume import, returns `NoProfile` and stores nothing;
  - builds the report (`buildCareerDna`), reads the newest stored version, saves the snapshot
    (`saveCareerDnaReport`) and returns the report, whether a version was stored, the version, and
    `changeLines` against the previous version.
- **`profile dna`** prints the report's label, strength and gap lines, the version, and what
  changed (Paul only: it reads his profile). Without a resume import it says to import one first
  and exits 1.

## Acceptance criteria
- [ ] With no import, nothing is saved and the command says so.
- [ ] A refresh saves version 1 and says it is the first report; an unchanged second refresh stores
      nothing and says nothing changed.
- [ ] A new approved story changes the next refresh's lines and stores version 2.
- [ ] An atom's imported quote counts toward its dimension (the quote joins by atom id).
- [ ] `pnpm turbo run lint typecheck test build` passes in `packages/profile`.

## Out of scope
- Rebuilding automatically after an import or a story approval; the page; the share card.

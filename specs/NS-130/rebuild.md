# NS-130 slice 6: rebuild the Career DNA report when the profile changes

Status: in progress (autonomous lane, ADR-0016)
Requirements: DNA-008 ("Rebuilt when the profile changes")
Rules that apply: ADR-0004, ADR-0007 (fail small), `.claude/rules/tests.md`.
Issue #54 (Paul's). Slices 1–5: #319, #321, #323, #327, #330.

## Why
Slice 5 builds and saves the report, but only when Paul runs `profile dna`. The report's inputs are
the current resume import's atoms and Paul's approved stories, and today they change in two places
only: `profile import-resume` (a new import) and `profile interview` (an approved story).

## Behavior
- After `profile import-resume` reports `imported`, the command runs `refreshCareerDna` and prints
  `Career DNA: saved as version N.` (or `Career DNA: unchanged since version N.`) and the change
  lines, indented.
- After `profile interview` reports `approved`, it does the same.
- `unchanged`, `rejected` and `model` imports and `skipped`, `stopped`, `no_atoms` and
  `atom_not_found` interviews don't refresh.
- A refresh that fails (an error result or a thrown error) prints
  `Career DNA not refreshed: run profile dna to try again.` and leaves the command's exit code
  as it was. The import or story is already stored, so the refresh is a separate step.
- The lines are the rubric's fixed words and counts, never atom or story text.

## Acceptance criteria
- [ ] A successful import refreshes the report and prints the version and what changed.
- [ ] An approved story refreshes the report.
- [ ] An unchanged import and a skipped interview don't refresh.
- [ ] A refresh that fails, or throws, leaves the exit code at 0 and prints the retry line.
- [ ] `pnpm turbo run lint typecheck test build` passes in `packages/profile`.

## Out of scope
- LinkedIn and site imports: the report doesn't read them yet.
- Accepted audit lines: the report scores the imported quote, as scoring does.
- The page and the share card.

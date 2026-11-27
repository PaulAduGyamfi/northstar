# NS-130 slice 7: LinkedIn and site atoms as Career DNA inputs

Status: in progress (autonomous lane, ADR-0016)
Requirements: DNA-001 ("built from the profile graph: … imported sources (GitHub, LinkedIn
export)"), DNA-008 ("Rebuilt when the profile changes")
Rules that apply: ADR-0004, ADR-0007, `.claude/rules/db.md` (a reader names its source kind),
`.claude/rules/tests.md`.
Issue #54 (Paul's). Slices 1–6: #319, #321, #323, #327, #330, #331.

## Why
The report scores only the current resume import's atoms and approved stories. Paul's LinkedIn
export (NS-133) and personal site (NS-209) are stored as their own `profile_source` with their own
atoms, but nothing reads them into the report, and importing them doesn't rebuild it.

## Behavior
- `readSourceAtoms(db, candidateId, kind)` (`packages/db`, read-only) gives the atoms of the
  current, not superseded import of one non-resume kind (`linkedin` or `site`): id, what, how and
  imported quote, in their order; `[]` before any import of that kind.
- `refreshCareerDna` takes an optional `readSourceAtoms` port. With it, the report scores the
  resume's atoms, then LinkedIn's, then the site's.
- **Counted once.** A LinkedIn or site atom whose imported quote, compared case-folded with
  whitespace collapsed, equals a resume atom's quote or an earlier added atom's is left out, so the
  same line copied into LinkedIn doesn't add points twice. The resume atom keeps the citation.
- The DNA-001 check gets every atom id that was scored, so a LinkedIn or site atom is a valid
  citation.
- Still needs a resume import: without one, `NoProfile` as before (the report is anchored on the
  resume; LinkedIn alone builds nothing).
- After `profile import-linkedin` and `profile import-site` store a new import, the command runs
  `refreshAfterChange`, as `import-resume` does. An unchanged or refused import doesn't refresh.
- Snapshots stay ids and numbers only (`career_dna_report`); no text goes into events or spans.

## Acceptance criteria
- [x] The reader returns the current LinkedIn (or site) import's atoms and never resume atoms.
- [x] A LinkedIn atom with a rubric term adds its point and is cited; the check accepts it.
- [x] A LinkedIn line that repeats a resume line (case and spacing aside) adds nothing.
- [x] Without the port the report is exactly as before.
- [x] A new LinkedIn or site import refreshes the report; an unchanged one doesn't.
- [x] `pnpm turbo run lint typecheck test build` passes in `packages/db` and `packages/profile`.

## Out of scope
- Employment facts and growth tracks as inputs; GitHub (no importer yet).
- The page, the Profile Grade handoff and the share card.
- No migration.

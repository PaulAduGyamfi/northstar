# NS-130 slice 4: store Career DNA reports and say what changed

Status: in progress (autonomous lane, ADR-0016)
Requirements: DNA-008 (refresh and history), DNA-001…003
Rules that apply: ADR-0004, ADR-0012, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Issue #54 (Paul's). Slices 1–3: #319, #321, #323.

## Why
DNA-008: the report is rebuilt when the profile changes, versions are kept, and a "what changed
since last time" diff gives Paul a reason to come back. Slices 1–3 build the report in memory only.

## Behavior
- **`career_dna_report`** (`packages/db`, `career-dna-schema.ts`, migrations 0088–0089): append-only,
  one row per version per candidate (version 1, 2, …). It stores a snapshot only: the rubric
  version and family, each dimension's key, band, points and evidence count with its cited atom and
  story ids, the archetype's label and dimensions, and the snapshot's SHA-256. Never atom or story
  text and never the report's sentences (they are rebuilt from the snapshot and the rubric).
- **`saveCareerDnaReport`** (`career-dna-write.ts`) checks the snapshot's shape, locks the candidate
  row, and stores a new version only when the snapshot differs from the newest one (the same
  report stores nothing and returns the newest version). Its `career_dna.saved` event, on
  `candidate:<id>`, carries the row id, version and dimension count; its feed line is its fixed
  `reason` ("Updated your Career DNA report").
- **`readCareerDnaHistory`** gives the candidate's versions, newest first (at most 20).
- **`careerDnaSnapshot`** (`packages/profile`, `career-dna/history.ts`) turns a built report into
  the stored snapshot. **`diffCareerDna(previous, next)`** (plain code) says what changed:
  dimensions whose band or points moved (up or down), an archetype change, and how many cited
  items were gained and lost. **`changeLines`** puts it in fixed sentences; with no previous
  version it says this is the first report.

## Acceptance criteria
- [ ] Saving a report twice stores one version; a changed report stores version 2.
- [ ] A snapshot with atom text, an unknown band or a bad id is refused and stores nothing.
- [ ] Another candidate's history is empty.
- [ ] The table refuses UPDATE, DELETE and TRUNCATE.
- [ ] The event carries no atom or story id and no text.
- [ ] `diffCareerDna` reports a band crossing, points up and down, an archetype change and gained
      and lost evidence; `changeLines` says "first report" with no previous version.
- [ ] `pnpm turbo run lint typecheck test build` passes in the touched packages.

## Out of scope
- Building from the stored profile on a profile change (the caller), the page, the share card.

## Open questions
- Keep every version, or only the last N? Slice 4 keeps all; the read returns 20.

# NS-130: Career DNA, the report's core (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: DNA-001, DNA-002, DNA-003 (`docs/requirements/07-profile-optimization.md`)
Rules that apply: ADR-0004 (no fabrication), ADR-0016, `.claude/rules/tests.md`

## Why
Paul wants a career report that shows what his work actually proves: demonstrated strengths, a
label he can stand behind, and where the proof is thin. It is "not a personality quiz". Every line
must come from his profile graph and say how sure it is. This slice builds the part every later
piece rests on: the strength scores, the archetype and the citation check. All of it is plain code,
so a score can never come from a model.

## Behavior
New folder `packages/profile/src/career-dna/`, plain code with no model, database or network:

- `rubric.ts`: the fixed, versioned rubric (`CAREER_DNA_RUBRIC`, version 1, role family
  `software_engineering`), with six dimensions from DNA-002's own list: engineering, architecture,
  infrastructure, leadership, communication, problem-solving.
  - Each dimension lists whole-word terms, matched case-blind against an atom's `what`, `how` and
    resume line.
  - It also lists the story competencies (the fixed `COMPETENCIES` list) that count toward it.
- `scoreDimensions(evidence)` scores each dimension from Paul's atoms and approved stories:
  - an atom that matches is worth 1 point, and an approved story tagged with a counted competency
    is worth 2;
  - each item counts at most once per dimension.

  Each result keeps its cited atom and story ids, its evidence count and its band:
  - fewer than 3 items: `not_enough`, which shows no score;
  - 3–5: `low`;
  - 6–9: `medium`;
  - 10 or more: `high`.

  While the dimension still has 3 or more items, removing one cited atom lowers its points by
  exactly 1. At 2 items it reads "not enough evidence yet" instead.
- `archetypeOf(scores)`: the two dimensions with the most points that aren't `not_enough` (ties go
  by rubric order), mapped to a label through a fixed table. A single qualifying dimension gets its
  own label, and none gives `null`. The archetype's evidence is the union of its dimensions'
  citations ("why this label"). The labels name the work ("The Systems Builder"), never a trait.
- `buildCareerDna(evidence)`: the report.
  - It has the rubric version, the dimensions, the archetype and the report lines.
  - Every line is a `strength` (cites at least one atom or story), a `label` (cites the archetype's
    evidence) or a `gap` ("Architecture: not enough evidence yet", no score).
- `checkCareerDna(report, known)`: the DNA-001 check, run on every report before it's shown. It
  refuses:
  - a strength or label line with no citation;
  - a citation to an atom or story id not in `known`;
  - a gap line that carries a score.

## Acceptance criteria
- [ ] A dimension with fewer than three cited items reads "not enough evidence yet" and shows no score (test).
- [ ] Removing one cited atom lowers that dimension's points by exactly 1 while it keeps 3+ items, and leaves no score at 2, with no model call (tests).
- [ ] An approved story counts 2 points toward each dimension its competencies map to, at most once (test).
- [ ] Terms match whole words only ("led" does not match "filed") (test).
- [ ] The archetype comes from the top two qualifying dimensions through the fixed table, ties by rubric order, and is `null` with no qualifying dimension (tests).
- [ ] `checkCareerDna` refuses an uncited strength line, an unknown id and a scored gap line, and passes `buildCareerDna`'s own output (tests).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` and `node evals/dist/bin.js --all` pass.

## Failure modes
No dependency: pure functions over arrays Paul's profile already holds. Empty evidence gives six
gap lines and no archetype, never an error.

## Observability
None in this slice: nothing calls it, and pure functions emit no events. The caller that stores a
report (DNA-008) writes `career_dna.built` with counts and bands only, never atom text.

## Out of scope
- DNA-001's other inputs: employment facts and growth tracks. LinkedIn and site lines already
  arrive as atoms, so they count.
- Directions from the job feed (DNA-004), the Profile Grade and growth handoffs (DNA-005/006).
- Storage, versions and the diff (DNA-008), and any CLI or page.
- The share card and public page (DNA-007): they wait on a Publish gateway ADR (an ADR-0002
  amendment) and hosting (Q-10), both Paul's.
- Model-drafted wording (the route and its eval set arrive with the slice that shows the report).
- Rubrics for other role families.

## Open questions
Paul's issue lists these as his. I picked defaults under his delegation of 2026-11-26 ("Anything
needed from my use your recommended choice"), and recorded them in the PR:
- the dimension set: DNA-002's own example list, for software engineering only;
- the terms, the points (1 per atom, 2 per story) and the band edges (3 / 6 / 10);
- the archetype labels, which name work and never a job title ("Lead"), since titles are locked
  facts.

The chart (radar or bars) comes with the page, not this slice.

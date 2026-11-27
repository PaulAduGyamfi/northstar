# NS-238 item 3, slice 2: grading learns from Paul's regrades, within bounds

Status: in progress (autonomous lane, ADR-0016)
Issue: #266 item 3 (parent #118)
Requirements: REC-003
Rules that apply: ADR-0004 (code decides), ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`,
`.claude/rules/tests.md`

## Why
Slice 1 (#402) stores Paul's own letter for a graded recruiter email. REC-003 says the grading
learns from it. This slice turns his regrades into small, bounded point adjustments per reason,
stores each change so he can see it, and lets the grader apply them. Plain code, no model.

## The learning rule (a decision made without Paul; REC-003 doesn't set one)
- Letters count A = 4, B = 3, C = 2, D = 1, F = 0. For each message Paul regraded, `delta` is his
  current letter minus the stored grade's letter (positive: he likes it more than the grader did).
- Each of the stored grade's reasons collects that delta. `dealbreaker` and every `red_flag:*`
  reason are never adjusted: they cap a grade, they don't add points.
- A reason's adjustment is the mean of its deltas, rounded to the nearest whole point and held to
  −2…+2, and only once 3 or more regraded messages carry the reason (`MIN_REGRADES`). Fewer than
  that, or a mean that rounds to 0, gives no adjustment.
- It is recomputed from all of his current regrades each time, never added up on top of the last
  result, so it can't run away. It only ever changes points, and so the letter. It never drafts,
  sends, archives or moves a status.

## Behavior
- **`packages/domain`** (`recruiter-learn.ts`): `ADJUSTABLE_REASONS`, `MIN_REGRADES`,
  `MAX_ADJUSTMENT`, and `learnRecruiterWeights(samples)`, which turns `{ reasons, systemGrade,
  paulGrade }[]` into `{ reason → adjustment }` by the rule above.
- **`packages/sources`** (`gradeRecruiterMessage`): an optional `weights` argument adds each
  matching reason's adjustment to the points before the letter is picked. Without weights, every
  grade is exactly as before.
- **Storage** (`packages/db`, migration 0103, `recruiter-weight-schema.ts`): append-only
  `recruiter_weight`, one version per change: an identity `position`, the adjustments as a JSON
  object of listed reasons to whole numbers in −2…+2 (a CHECK on the bound), and how many regrades
  it came from.
- **Write** (`recruiter-weight-write.ts`): `refreshRecruiterWeights(tx, candidateId)` reads the
  stored grades of Paul's regraded messages and his current letters, runs
  `learnRecruiterWeights`, and stores a new version only when the result differs from the newest.
  A new version writes `recruiter.weights_adjusted` (the changed reasons and their new values, by
  `system`), feed "Adjusted recruiter grading from your regrades: N changes".
  `regradeRecruiterMessage` calls it in the same transaction as a stored regrade.
  `readRecruiterWeights` gives the newest adjustments (empty when none).

## Acceptance criteria
- [ ] The rule: deltas averaged per reason, rounded, held to ±2, at least 3 regrades, caps never
      adjusted (unit tests).
- [ ] `gradeRecruiterMessage` with weights moves points and letter; without, unchanged (tests).
- [ ] A regrade that changes the result stores one new version and one event; one that doesn't
      stores nothing; the table refuses UPDATE, DELETE, TRUNCATE and an out-of-bound value (PGlite).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Replies and archives as signals, a settings page for the weights, the agreement measure (item 4)
  and the caller that grades new mail (item 1).

# NS-238 item 3, slice 3: grading applies the learned weights, learning stays on the grader's letter

Issue: #266 item 3 (parent #118) · Requirements: REC-003 · Rules: ADR-0004, ADR-0012, ADR-0016,
`.claude/rules/db.md` · Builds on: slice 2 (`specs/NS-238-weights/spec.md`), `funnel inbox`
grading (#415), replies by grade (#439)

## Why
Slice 2 learns bounded point adjustments from Paul's regrades and stores them in
`recruiter_weight`, but `funnel inbox` grades with none, so his regrades never change a grade.
Slice 2's spec also sets the condition for applying them: learning must keep comparing his letter
with the grader's own, unweighted one. If it compared against a grade that already included the
weights, agreeing with a corrected grade would pull a weight back toward 0 and let the old error
return.

## What changes
1. **Stored: both letters.**
   - `recruiter_grade.grade` and `points` stay the grader's unweighted result.
   - Migration 0107 adds three nullable columns: `weighted_grade` (A–F), `weighted_points`, and
     `weights_position` (the `recruiter_weight` version applied).
   - A CHECK requires all three set or all three null, and holds `weighted_points` within ±2 of
     `points` (`MAX_TOTAL_ADJUSTMENT`).
   - The columns are all null when no weights exist, and on every grade stored before this.
   - The table stays append-only. A grade's letters never change after it is stored.
2. **Grading.**
   - `funnel inbox` reads `readRecruiterWeights` once a run, now with its version.
   - It grades each message twice with `gradeRecruiterMessage`: once with no weights (stored as
     `grade`), once with them (stored as the weighted letter). It skips the second when there are
     no weights.
   - `recordRecruiterGrade` takes the optional weighted part.
   - `recruiter.graded` carries both letters. Its feed line names the letter the Inbox shows.
3. **Learning is unchanged.** `refreshRecruiterWeights` still reads `recruiter_grade.grade`, the
   unweighted letter, for each delta. A test proves a weighted grade doesn't move it.
4. **What the Inbox shows.** The thread's letter is Paul's regrade, else the weighted letter, else
   the grader's.
   - When the weighted letter differs from the grader's, it adds "Adjusted from B by your
     regrades" (`readInboxThreads` gives `systemGrade` and `weightedGrade`).
   - The Regrade picker starts at the shown letter.
   - The reply step (`readReplyCandidates`) follows the same letter: Paul's, else weighted, else
     the grader's. It never replies to an F.
5. **Docs.** AGENTS.md, `.claude/rules/db.md` and the README.

## Out of scope
- Re-grading mail graded before the weights changed. A grade is stored once.
- Replies and archives as learning signals: archiving needs `gmail.modify`, which ADR-0027
  rejected, and sent mail isn't read.
- A settings page for the weights.
- Item 4.

## Decisions made without Paul
- **A schema change:** migration 0107 adds three nullable columns to `recruiter_grade`. The
  orchestrator gave this agent the migration lane.
- **Weighted letters are stored, not computed on read,** so the Inbox shows exactly what the run
  graded. The version that produced it is recorded, so a later weights change never rewrites an
  old grade.

## Acceptance criteria
- [ ] No weights: the grade is stored exactly as before (weighted columns null).
- [ ] With weights: both letters and the version are stored, and the event carries both.
- [ ] Learning reads only the unweighted letter.
- [ ] The Inbox shows Paul's letter, else the weighted one, else the grader's, with the "adjusted"
      line when the weighted letter differs.
- [ ] The reply step follows the shown letter.
- [ ] The table refuses a partial or out-of-bound weighted part, and still refuses UPDATE and
      DELETE.

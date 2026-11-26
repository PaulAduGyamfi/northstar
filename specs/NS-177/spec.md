# NS-177: Apply ledger: candidate-scoped application FK, half-close repair, schedule the sweep

Status: accepted (autonomous lane, ADR-0016), parts 1 and 2 in this PR
Requirements: APPLY-007, APPLY-009 · ADR-0002, ADR-0007, ADR-0012
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #78 (NS-143)

## Why
NS-143 added the stale-claim sweep and left three parts out:
1. `apply_submission.application_id` references `application.id` alone, so a ledger row could
   point at another candidate's application.
2. `closeStaleClaim` writes the ledger and moves the application in separate transactions. A
   crash between them leaves the ledger at `needs_human` (`outcome_unknown`) and the application
   at `awaiting_approval` or `submitting`. Nothing repairs it.
3. Nothing runs the sweep.

## What changes
1. **Composite foreign key.** `apply_submission (application_id, candidate_id)` references
   `application (id, candidate_id)`; the unique key it needs (`application_id_candidate_unique`)
   already exists. One generated migration. The old single-column FK stays (dropping it gains
   nothing and changes more).
2. **Half-close repair.**
   - `listHalfClosedClaims(db, candidateId)` (`packages/db`, `apply-write.ts`): ledger rows at
     `needs_human` with reason `outcome_unknown` whose application is `awaiting_approval` or
     `submitting`.
   - The sweep also finishes those moves, through the same helper as a fresh close, with the
     same `applyMoveKey` keys, so a repeat writes one event per move.
   - Tested on PGlite through `dbSweepPorts`.
3. **Scheduling the sweep** needs the worker (NS-157, #108, blocked). It moves to a follow-up
   issue; this PR closes nothing.

## Acceptance criteria
- [ ] The database refuses a ledger row whose application belongs to another candidate.
- [ ] A ledger row closed without its application move is repaired by the next sweep, from
      `awaiting_approval` and from `submitting`; a second sweep writes nothing.
- [ ] Repaired moves use `applyMoveKey`, so a sweep racing a repeated `submitApplication` writes
      one event per move.

## Out of scope
Part 3 (above): the worker entry point, its interval, and `loadApplyLimits` there.

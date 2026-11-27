# NS-249 slice 1: `requestApproval` refuses caller facts for application packages

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #297 item 1 (parent #195). Decision on #297 (2026-11-27, delegated by Paul): yes; item 1
first; no assertion loosened; every changed test listed in the PR.
Requirements: APR-004, APPLY-003, APPLY-004 · ADR-0002, ADR-0017
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
NS-213 slice 1 made the Gate derive an application package's policy facts from storage
(`requestPackageApproval`), but `requestApproval` still takes facts from any caller. A confused
or buggy producer could still pass facts that match one of Paul's auto-approve rules.

## Behavior
- `requestApproval` (`packages/db`, `approval-write.ts`) refuses any request whose `facts` isn't
  null: `InvalidRequest` naming `facts`. Its input type says `facts: null`. Other kinds already had
  this rule; now application packages do too. A package filed with `facts: null` still waits for
  Paul, and with no stored package it can never be submitted (`readDecisionPackage`).
- `requestPackageApproval` files through an internal entry, `requestApprovalWithFacts`, exported
  from `approval-write.ts` but not from the package's index, so only `packages/db` code can pass
  facts, and only the facts it derived.
- Tests that relied on caller facts now file a real package through `requestPackageApproval`,
  using a test-only fixture (`src/test/package-fixture.ts`) that stores what auto-approval needs:
  the job's posting, Paul's contact, a tailored resume, the form, a fit score and a form sent
  before. The package fills no fields, so every answer counts as reused. What each test checks
  stays the same.

## Acceptance criteria
- [x] `requestApproval` with non-null facts is refused for every kind, before anything is stored.
- [x] `requestPackageApproval` still auto-approves on facts it derived (its tests unchanged).
- [x] Every test that passed facts files through `requestPackageApproval`; no assertion loosened.
- [x] The index doesn't export `requestApprovalWithFacts`.
- [x] lint, typecheck, test and build green for db and every package that imports it; docs.

## Out of scope
- Item 2 (the question canon move and the Gate's per-answer question check): its own slice.

## Decisions made without Paul (ADR-0016)
- The internal entry point, exported only from `approval-write.ts`.

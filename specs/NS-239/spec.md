# NS-239: Close the Gate request of an application withdrawn because its posting closed

Status: in progress
Requirements: SRC-010, APR-004 · ADR-0002, ADR-0017
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #209, issue #267.

## Why
NS-218 moves a closed job's application that hasn't gone out to `withdrawn`. Its
`application_package` Gate request stays open, though: pending in Paul's Queue, or live if he
already approved it. It can never act, because `withdrawn` is final. It should close, visibly, and
only through the Gate's own write path.

## Behavior
- **Gate (`packages/db`, `approval-write.ts`):** `withdrawApproval` takes a third kind,
  `{ by: "system" }`, with reason `posting_closed`. It applies only to an `application_package`
  request; another kind is `NotFound`. It may close a pending or approved request, inside the undo
  window or not, because the application can't go out either way.
  - Its `approval.withdrawn` event carries `withdrawnBy: "system"` and `reason: "posting_closed"`.
  - It does not count as Paul's withdrawal: a policy may still approve the subject if it is
    requested again.
- **Database (migration):**
  - `approval_withdrawal`'s CHECKs allow `system` only with `posting_closed`.
  - The guard function refuses a `system` withdrawal of any request that isn't an
    `application_package`.
- **Liveness (`liveness-write.ts`):** after moving applications, `withdrawClosedApplications` also
  closes the open package requests of every `withdrawn` application on a closed job. Those requests
  are found from the application's own package rounds
  (`application:<id>:package:<packageId>:package_ready` → subject
  `application_package:<packageId>`). A failure counts in `failed`, and the return shape is
  unchanged. A repeat closes nothing new.
- **Feed (`packages/domain`, `feed.ts`):** a system withdrawal for a closed posting reads "An approval
  request was closed because the job's posting closed".

## Acceptance criteria
- [ ] A withdrawn application's pending request, and its approved request, both close. Each leaves
      the queue, `verifyApproval` says `Withdrawn`, and an `approval.withdrawn` event is written
      (PGlite).
- [ ] A repeat closes nothing new; other applications' requests are untouched.
- [ ] A `system` withdrawal of another kind is refused, in code and by the trigger.
- [ ] The feed line.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A schema change: the withdrawal CHECKs and the guard function.
- The Gate's own path (`withdrawApproval`), not hiding requests in `listPendingApprovals`: hiding
  would leave an approval live for `verifyApproval`.

## Out of scope
- Reopening: a reopened posting doesn't revive a withdrawn application.

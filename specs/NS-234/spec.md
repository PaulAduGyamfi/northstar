# NS-234: Withdraw a changed package's approval after its undo window

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: APR-004, RES-006, RES-007 (never a silent drop) · ADR-0002, ADR-0007, ADR-0017.
GitHub issue #255 (Parent: #193).
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/worker.md`, `.claude/rules/tests.md`.

## Why
`verifyApproval` checks `ContentChanged` before `UndoWindowOpen`. So a package edited inside the
2-minute undo window reaches the Apply Gateway as `ContentChanged`, and the gateway's withdrawal
(NS-211) is refused with `UndoWindowOpen`: the approval is still Paul's to undo. That refusal is
recorded on the span only. The worker treats `NotApprovedError("ContentChanged")` as final, so
nothing calls again after the window. The approval stays live for the old content, its subject
can't be requested again, and nothing appears in the feed.

## Behavior
1. **The gateway reports when to come back.** `withdrawChanged` (`packages/gateways`,
   `submit.ts`) returns the window's end when the Gate refuses the withdrawal with
   `UndoWindowOpen`. `NotApprovedError` gains `retryAt: Date | null`: set only in that case, and
   `null` for every other refusal and after a successful withdrawal.
2. **The worker waits it out** (`apps/worker`, `src/activities/apply.ts`). A
   `NotApprovedError("ContentChanged")` with a `retryAt` becomes a dated `UndoWindowOpen` wait:
   - `{ kind: "refused", refusal: "UndoWindowOpen", waitMs }`, until `retryAt`;
   - `decide` already treats `UndoWindowOpen` as "not now", within its 20 waits;
   - the next call finds `ContentChanged` again, the window has closed, and the withdrawal goes
     through, giving the Gate's `approval.withdrawn` feed line;
   - the run then ends as `not_approved` (`ContentChanged`), which NS-226 records as a dead letter.
3. **Nothing else changes.** Any other `NotApprovedError`, or `ContentChanged` with no
   `retryAt`, is final as before.

## Acceptance criteria
- [ ] Gateway test on the real write paths (PGlite): a package edited inside the undo window
      throws `NotApprovedError("ContentChanged")` with `retryAt` at the decision's `effectiveAt`.
      After the window, a second call withdraws the approval (`approval.withdrawn`) and throws
      with `retryAt: null`.
- [ ] Activity test: a `ContentChanged` with a `retryAt` returns a dated `UndoWindowOpen` wait.
      Without one it is still the non-retryable `NotApproved` failure.
- [ ] The existing NS-211 tests still pass unchanged.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope
- The other two options in #255 (the producer retries, or a separate visible item). The worker
  retry covers the case, and the ending is already visible through NS-226's dead letter.

## Decisions (ADR-0016)
- **Option 1 of #255 (retry in the worker).** It is the smallest change, with no schema, and
  reuses the existing undo-window wait.

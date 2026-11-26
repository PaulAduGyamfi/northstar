# NS-211: The Apply Gateway withdraws an approval whose package changed for good

Status: accepted (autonomous lane, ADR-0016)
Requirements: APR-004 (approval records are immutable and referenced by the action they
authorize), APPLY-* via ADR-0002 (the Apply Gateway checks the Gate at the moment it acts)
Rules that apply: ADR-0002, ADR-0007, ADR-0016, ADR-0017, `.claude/rules/gateways.md`,
`.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #69 (NS-140 item 1, the withdraw record)

## Why
NS-140 gave the Gate `withdrawApproval`, so a gateway can close an approval whose content changed
for good and the subject can be requested again with the new package. The Apply Gateway doesn't
call it yet: an application whose package was edited after Paul approved it stays approved for
the old content forever, and its subject can never be requested again.

## Behavior
1. **Gate lookup** (`packages/db`, `approval-write.ts`). `requestOfDecision(db, { candidateId,
   decisionId })` is read-only. It returns `{ requestId }` for a decision of that candidate, or
   `NotFound` (a malformed id, an unknown one, or another candidate's). It writes nothing and
   opens an `approval.request_of` span with the outcome only.
2. **Apply Gateway** (`packages/gateways`). `ApplyPorts` gains `requestOfDecision` and
   `withdrawApproval`, wired by `dbPorts` to the Gate functions.
   - When `verifyApproval` refuses with `ContentChanged`, and only then, `submitApplication`
     looks up the decision's request and calls `withdrawApproval({ by: "gateway", requestId,
     newContentSha256: packageSha256(pkg) })`. Then it still throws
     `NotApprovedError("ContentChanged")`.
   - "Permanent" means the Gate's `ContentChanged`: the subject matched and the hash of the whole
     parsed package (file hashes included) differs from the approved one. The gateway's own
     `FileChanged` (stored bytes don't match the package's own file hash) is transient and
     withdraws nothing. Every other Gate refusal withdraws nothing.
   - If the lookup or the withdrawal is refused (`NotFound`, `NotApproved`, `UndoWindowOpen`,
     `AlreadyClosed`, `ContentUnchanged`), the gateway records that kind on the span as
     `northstar.apply.withdraw` and throws the same `NotApprovedError("ContentChanged")`. A
     successful withdrawal records `withdrawn`.
   - No `needs_human` ledger row: the refusal comes before any claim, and such a row would make
     the resubmission under the new approval replay as `needs_human` forever. The visible item is
     the Gate's `approval.withdrawn` feed line plus the thrown error.
3. `verifyApproval`'s return value and the `ContentChanged` type are unchanged.

## Acceptance criteria
- [ ] `requestOfDecision` finds a decision's request, returns `NotFound` for an unknown id, and
      `NotFound` for another candidate's decision (`approval-withdraw.test.ts`).
- [ ] On fakes: a `ContentChanged` refusal withdraws once with the new package hash and still
      throws `NotApprovedError("ContentChanged")`; a `FileChanged` withdraws nothing; another Gate
      refusal withdraws nothing; a refused withdrawal is on the span and still throws.
- [ ] On the real write paths (`submit-db.test.ts`): the edited package withdraws the approval
      (one `approval.withdrawn` event, no ledger row); the old decision id is then refused even for
      the original package (`Withdrawn`); a new approval for the same subject submits; an edit
      inside the undo window records `UndoWindowOpen` on the span and still throws.
- [ ] No existing assertion changes. `/verify` passes in `packages/db` and `packages/gateways`.

## Failure modes
- Postgres down during the lookup or the withdrawal: the error propagates as a `GatewayError`
  throw, like any Gate failure; nothing was claimed, so a later call tries again.
- Two runs meet the same edit at once: the second withdrawal gets `AlreadyClosed`, recorded on its
  span; both throw `NotApprovedError("ContentChanged")`.
- Edited inside the undo window: the Gate refuses with `UndoWindowOpen` (the approval is still
  Paul's to undo); recorded on the span, thrown, nothing withdrawn. A call after the window
  would withdraw it, but nothing makes that call yet: the worker treats `ContentChanged` as final.
  Follow-up #255 retries or shows it.

## Observability
- `approval.withdrawn` domain event (written by the Gate; feed line "Withdrawn because the
  approved content changed").
- `approval.request_of` span (outcome only), the Gate's `approval.withdraw` span, and
  `northstar.apply.withdraw` on `apply.submit` (`withdrawn` or the refusal kind).

## Out of scope
- Withdrawing from other gateways (none exist yet) or from the answer bank.
- Telling the producer to request the new package: the workflow that would do it doesn't exist.
- Restricting who may withdraw: callers are internal only (see the security note in the PR).

## Open questions
- None. The two design choices (a read-only lookup rather than adding `requestId` to
  `ContentChanged`, which would change existing assertions; no `needs_human` row) are recorded in
  the PR under "Decisions made without Paul".

# NS-246 slice 2: the reveal's database guards

Status: built (autonomous lane, ADR-0016; holds the `packages/db` migration lane)
Requirements: CRD-002, CRD-003 · ADR-0024, ADR-0010 · Issue #290 (Parent: #286)

## Why
Paul's reveal (NS-182) is guarded in code: `openSealedSecret` refuses a reveal decision, and only
`revealSealedSecret` writes a `reveal_to_user` access. The database only pairs `user` with
`reveal_to_user`. A writer that skips `vault-write.ts` could still open the vault for an agent under
a reveal decision, or reveal under an application's approval. Nothing stops anyone withdrawing a
reveal, and its feed line reads "Waiting for your approval: vault reveal", which is wrong: a reveal
never waits.

## Behavior
- Migration 0095, trigger `vault_access_reveal_checks` (BEFORE INSERT on `vault_access`): an access
  under a `vault_reveal` decision must have purpose `reveal_to_user`, and a `reveal_to_user`
  access needs a `vault_reveal` decision. Either violation is a `check_violation`.
- Migration 0095 replaces 0081's `approval_withdrawal_guard` with the same locks and checks plus one
  rule: a `vault_reveal` request is never withdrawn.
- `withdrawApproval` answers `NotFound` for a `vault_reveal`, for `user`, `gateway` and `system`.
- `feedLine` for `approval.requested` of kind `vault_reveal`: "You asked to see a saved password",
  never the tenant.
- No new table, so no grant; no change to the vault boundary test's allow-lists.

## Acceptance criteria
- [x] The database refuses an agent's access under a reveal decision.
- [x] The database refuses a reveal under an application's approval.
- [x] `withdrawApproval` answers `NotFound` for every withdrawer, and a direct insert is refused.
- [x] The reveal's feed line says Paul asked, never that it waits or which tenant.
- [x] `pnpm turbo run lint typecheck test build` passes in `packages/db` and `packages/domain`.

## Out of scope
- Moving keyboard focus after a reveal; sharing `reveal.ts`'s constants (optional notes, slice 1).

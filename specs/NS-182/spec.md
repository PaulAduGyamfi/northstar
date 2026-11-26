# NS-182: Reveal a vault password to Paul (slice 1: the Gate and the vault)

Status: accepted (autonomous lane, ADR-0016)
Requirements: CRD-002 (the UI part), CRD-003
Rules that apply: ADR-0002, ADR-0010, ADR-0017, ADR-0022, ADR-0024 (this ticket),
`.claude/rules/db.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`
Parent: #21

## Why
CRD-002: "The UI can reveal a password only after a fresh passkey check." The vault decrypts
only inside `packages/gateways` and only under a live Gate approval. NS-221 (#219) decided, under
Paul's delegation: the API loads the master key and calls one narrow gateway function (1a), and a
new approval kind `vault_reveal` authorizes each reveal, requested and approved in one step on a
fresh passkey assertion (2a). Two gaps the decision left open are decided here and recorded in
ADR-0024: the undo window, and what ties a reveal approval to one tenant and one use.

This slice builds the Gate and vault side. Slice 2 (the API route with the passkey check, loading
the key in the API, and the page) is a follow-up issue.

## Behavior
1. **packages/domain:** `vault_reveal` joins `APPROVAL_KINDS`. It is never auto-approvable.
   `revealContentSha256(tenantKey)` is the content hash a reveal request must carry.
2. **packages/db** (one migration):
   - The kind CHECK allows `vault_reveal`.
   - The decision trigger makes a `vault_reveal` decision take effect at once (no undo window:
     a reveal has nothing to cancel), and refuses a policy decision on it (already true: only
     application packages).
   - `openSealedSecret` accepts actor `user` with purpose `reveal_to_user`, and only that pair.
     For that purpose the decision must be Paul's approval of a `vault_reveal` request whose
     content hash is `revealContentSha256(tenantKey)`, and it must not have opened anything
     before (single use). Any other decision, or a reuse, is `NotApproved`. The access is audited
     in `vault_access` and `vault.opened` like any other.
   - Agents can't use a reveal approval for their own purposes: a `vault_reveal` decision opens
     nothing under any other purpose.
3. **packages/gateways:** `revealTenantPassword(ports, masterKey, { candidateId, tenantKey,
   decisionId })`, exported, returns a `VaultSecret` through `useTenantPassword` with actor `user`
   and purpose `reveal_to_user`. `open.ts` stays private, and the boundary test stays green.
4. **ADR-0024** records 1a, 2a, the zero undo window, the binding and single use.

## Acceptance criteria
- [ ] A `vault_reveal` approval by Paul takes effect at once; other kinds still wait 2 minutes.
- [ ] A reveal opens the tenant's password once and writes one `vault_access` row; a second
      reveal under the same decision is `NotApproved`.
- [ ] A reveal decision for another tenant, an application approval, a rejected or withdrawn
      reveal, and a locked vault are refused.
- [ ] A reveal decision can't open the vault for an agent's purpose, and actor `user` can't use
      any purpose but `reveal_to_user`.
- [ ] `@northstar/gateways` exports `revealTenantPassword`, still no decrypt function, and the
      boundary test is green.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
A refusal is a value (`NotApproved`, `VaultLocked`, `SecretNotFound`), never a thrown error with
details. A failure after the access is recorded leaves the audit row: the attempt is visible.

## Observability
`vault.opened` with purpose `reveal_to_user` and the decision id; the existing `db.vault.open`
span (tenant key and outcome only).

## Out of scope (slice 2, follow-up issue)
The API route (session, a WebAuthn assertion made within 60 s, request plus approve plus reveal),
loading `VAULT_MASTER_KEY_FILE` in the API while the `vault` switch is on, and the page that shows
the password once and masks it again.

## Decisions made without Paul (ADR-0016)
- **No undo window for `vault_reveal`:** the undo window exists to cancel something before it goes
  out; a reveal has nothing to cancel, and a 2-minute wait would defeat the 60-second passkey
  check. Recorded in ADR-0024 (amends ADR-0017 for this kind only).
- **Binding and single use:** a reveal decision names its tenant through its content hash and
  opens at most once, so one passkey check reveals one password once.
- **Schema change:** one migration (the kind CHECK and the decision trigger).
- **Split into two slices:** the API and page need the passkey flow and key loading, which are
  reviewed better on their own.

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
   `revealContentSha256(tenantKey)` is the content hash a reveal request carries.
2. **packages/db** (migrations 0056, generated, and 0057, the trigger):
   - The kind CHECK allows `vault_reveal`.
   - The `vault_access` actor CHECK pairs `user` with `reveal_to_user` only.
   - A unique index lets a reveal decision open once.
   - The decision trigger makes a `vault_reveal` decision take effect at once (no undo window).
   - `revealSealedSecret(db, { candidateId, tenantKey })`, in one transaction:
     - the vault must be unlocked and the tenant must have a secret;
     - it files a `vault_reveal` as `system` and records Paul's approval;
     - it records one access by `user` for `reveal_to_user`, with `vault.opened`.
     The decision id never leaves it.
   - `requestApproval` refuses `vault_reveal`, the Queue never lists one, and `decideApprovals`
     answers `NotFound`. `openSealedSecret` refuses actor `user`, purpose `reveal_to_user` and
     any reveal decision.
3. **packages/gateways:** `revealTenantPassword(ports, masterKey, { candidateId, tenantKey })`
   and `dbRevealPorts(db)`, exported. `open.ts` stays private. The boundary test allows only the
   vault's own files to name the reveal path.
4. **ADR-0024** records all of this.

## Acceptance criteria
- [ ] A reveal is filed by `system`, approved by Paul, effective at once, and names its tenant;
      an application approval still waits 2 minutes.
- [ ] Each reveal writes one `vault_access` row and one `vault.opened` under its own decision.
- [ ] A locked vault or a tenant with no secret is refused, and nothing is filed.
- [ ] No one can request a `vault_reveal` through the Gate; the Queue never shows one, can't
      decide it, and it can't be undone.
- [ ] `openSealedSecret` opens nothing under a reveal decision, and refuses Paul's actor and the
      reveal purpose; the database refuses a second reveal access and a mismatched pair.
- [ ] `@northstar/gateways` decrypts through `revealTenantPassword`, exports no other opening,
      and the boundary test is green, including its new reveal check.
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
- **One transaction for a reveal:** the security review found that a queue-filed reveal plus a
  caller-supplied decision id let an agent's request become a reveal. Now nothing outside
  `revealSealedSecret` makes or uses one.
- **Schema change:** migration 0056 (the kind and actor CHECKs, the reveal-once index) and 0057
  (the decision trigger).
- **Split into two slices:** the API and page need the passkey flow and key loading, which are
  reviewed better on their own.

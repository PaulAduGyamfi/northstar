# ADR-0024 — Revealing a vault password to Paul under a one-use `vault_reveal` approval

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

## Context
CRD-002 says the UI may reveal a tenant password only after a fresh passkey check. ADR-0010 keeps
decryption inside `packages/gateways` (`src/vault/open.ts`, private to the package, guarded by
the boundary test). ADR-0002 and `openSealedSecret` allow an opening only under a live Gate
approval (`vault_access.decision_id`). No approval kind covered "Paul reveals his own password".

NS-221 (#219) put two questions to Paul. An agent decided them on 2026-11-26 under his delegation
("Anything needed from my use your recommended choice"):
- 1(a): the API loads the master key and calls one narrow gateway function;
- 2(a): a new approval kind `vault_reveal`, requested and approved in one step when a fresh
  passkey assertion arrives.

Building it raised two more questions:
- ADR-0017 gives every decision a 2-minute undo window, which would outlast a 60-second passkey
  check.
- Nothing yet tied an approval to one tenant or to one use.

## Decision
1. **A `vault_reveal` approval kind** (`APPROVAL_KINDS` in `packages/domain`, and the kind CHECK
   in `packages/db`). It is never auto-approvable: only application packages are.
2. **A reveal is made, approved and used in one transaction.**
   - `revealSealedSecret` (`packages/db/src/vault-write.ts`) checks the `vault` switch and that
     the tenant has a secret.
   - It then files a `vault_reveal` request as `system`, records Paul's approval
     (`approveRevealWithin` in `approval-write.ts`, not exported from the package) and records
     one `vault_access` by actor `user` with purpose `reveal_to_user` under it.
   - The decision id never leaves the function, so no caller can reuse a decision or swap one in.
   - Every reveal is its own request, decision, access and `vault.opened` event.
3. **Nothing else makes or uses one.**
   - `requestApproval` refuses kind `vault_reveal` from anyone.
   - `listPendingApprovals` never shows one, and `decideApprovals` answers `NotFound` for one.
   - `openSealedSecret` refuses actor `user`, refuses purpose `reveal_to_user`, and opens nothing
     under a `vault_reveal` decision.
   - In the database, the `vault_access_actor_valid` CHECK pairs `user` with `reveal_to_user`
     only, and the unique index `vault_access_reveal_once` lets a reveal decision open once.
4. **It takes effect at once.** The decision trigger (`approval_decision_guard`, migration
   0057) sets `effective_at` to `decided_at` for `vault_reveal`. Every other kind keeps
   ADR-0017's 2 minutes. Such a decision can't be undone: its window has already closed.
5. **The tenant is in the record.** The request's content hash is
   `revealContentSha256(tenantKey)` (`sha256("vault_reveal:" + tenantKey)`, `packages/domain`),
   and its subject is `vault_reveal:<fresh uuid>`.
6. **Who may call it is what keeps it safe.** Whoever can call `revealSealedSecret` can reveal,
   because it makes its own approval. So:
   - `@northstar/gateways` exports `revealTenantPassword` (and its port, `dbRevealPorts`) as its
     one opening;
   - the boundary test fails if any file outside the vault's own files and tests names the reveal
     path;
   - slice 2 adds the API's reveal module to that list, and only it.
7. **The API holds the key (NS-221 1a; slice 2).** The API loads `VAULT_MASTER_KEY_FILE` only
   while the `vault` kill switch is on, listens on loopback only, and calls
   `revealTenantPassword` only after a WebAuthn assertion made within the last 60 seconds. If the
   worker later holds the key, the reveal moves there and leaves the API.

## Alternatives considered
- **Keep the 2-minute undo window:** the window exists to cancel something before it goes out.
  A reveal has nothing to cancel, and the wait would outlast the passkey check.
- **Treat the passkey assertion itself as the authority (NS-221 2b):** it would need an
  exception to "only under a Gate decision", and leave reveals out of the approval history.
- **A reusable reveal approval:** one passkey check could then reveal again later, or reveal
  other tenants. One use per check is easy to reason about.
- **Request and approve through the queue, then reveal with a decision id (this ADR's first
  draft):** any agent could file a reveal that Paul might approve in a batch without a passkey,
  and the reveal would trust whatever decision id its caller passed. The security review of
  NS-182 found this; doing it all in one transaction removes both.
- **A separate gateway process or waiting for the worker (NS-221 1b, 1c):** safer key placement,
  but a new process to run now, or no reveal until NS-225. Paul's delegation chose 1(a).

## Consequences
- + Every reveal leaves a Gate request, Paul's decision and a `vault_access` row under it.
- + No agent can file, approve or use a reveal, and Paul's actor can't open for an agent's
  purpose.
- − The API process will hold the master key while the vault is on, which ADR-0010 kept to the
  Apply Gateway. It still never imports `open.ts`.
- − One kind is now exempt from the undo window. That list lives only in the decision trigger.
- − A failed decrypt after the access is recorded (a wrong key) still counts as a reveal: it is
  audited.
- − The Gate's record says "approved by Paul" because the API calls this only after his passkey
  check. The database can't see the passkey, so the boundary test and code review guard the
  callers.

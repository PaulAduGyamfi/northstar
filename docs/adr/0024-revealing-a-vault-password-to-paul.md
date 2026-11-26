# ADR-0024 — Revealing a vault password to Paul under a one-use `vault_reveal` approval

**Status:** Proposed · **Date:** 2026-11-26

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
2. **It takes effect at once.**
   - The decision trigger (`approval_decision_guard`, migration 0057) sets `effective_at` to
     `decided_at` for `vault_reveal`. Every other kind keeps ADR-0017's 2 minutes.
   - `IMMEDIATE_KINDS` in `packages/domain` names the same list.
   - Such a decision can't be undone: its window has already closed.
3. **One tenant.** A reveal request carries `revealContentSha256(tenantKey)`
   (`sha256("vault_reveal:" + tenantKey)`) as its content hash. The request's subject is
   `vault_reveal:<fresh uuid>`, so each reveal is its own request. Requests are filed by
   `system`, and Paul decides them.
4. **One use, and only for Paul.**
   - `openSealedSecret` accepts actor `user` with purpose `reveal_to_user`, and no other pairing.
     The `vault_access_actor_valid` CHECK enforces the same rule.
   - For that purpose the decision must be Paul's approval of a `vault_reveal` request with this
     tenant's hash, and it must not appear in `vault_access` yet. The decision row's lock
     (`liveApproval`) serializes two attempts.
   - A `vault_reveal` decision opens nothing for an agent's purpose, and no other approval
     reveals.
   - The access is audited in `vault_access` and `vault.opened` like any other.
5. **One exported opening.**
   - `revealTenantPassword` (`packages/gateways/src/vault/reveal.ts`) always passes actor `user`
     and purpose `reveal_to_user`.
   - `open.ts` stays private, and the boundary test stays green.
6. **The API holds the key (NS-221 1a; slice 2).** The API loads `VAULT_MASTER_KEY_FILE` only
   while the `vault` kill switch is on, listens on loopback only, and calls
   `revealTenantPassword` after a WebAuthn assertion made within the last 60 seconds. It then
   requests and approves the `vault_reveal` in one step. If the worker later holds the key, the
   reveal moves there and leaves the API.

## Alternatives considered
- **Keep the 2-minute undo window:** the window exists to cancel something before it goes out.
  A reveal has nothing to cancel, and the wait would outlast the passkey check.
- **Treat the passkey assertion itself as the authority (NS-221 2b):** it would need an
  exception to "only under a Gate decision", and leave reveals out of the approval history.
- **A reusable reveal approval:** one passkey check could then reveal again later, or reveal
  other tenants. One use per check is easy to reason about.
- **A separate gateway process or waiting for the worker (NS-221 1b, 1c):** safer key placement,
  but a new process to run now, or no reveal until NS-225. Paul's delegation chose 1(a).

## Consequences
- + Every reveal leaves a Gate request, Paul's decision and a `vault_access` row under it.
- + An agent can't use a reveal approval, and Paul's actor can't open for an agent's purpose.
- − The API process will hold the master key while the vault is on, which ADR-0010 kept to the
  Apply Gateway. It still never imports `open.ts`.
- − One kind is now exempt from the undo window. A new immediate kind must be added in both
  `IMMEDIATE_KINDS` and the trigger.
- Open question: whether a stray pending `vault_reveal` (a request whose approval failed) should
  be hidden from the Queue. It reveals nothing without a fresh passkey check.

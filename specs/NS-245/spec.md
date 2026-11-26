# NS-245: Hardening for the reveal route (slice 1: tenant binding and a stricter boundary scan)

Status: approved under ADR-0016 (autonomous lane)
Requirements: CRD-002 · ADR-0010, ADR-0022, ADR-0024
Rules that apply: `.claude/rules/gateways.md`, ADR-0016

## Why
Two findings from NS-230's security review:
- A reveal challenge wasn't bound to a tenant, so one passkey check could reveal any tenant.
- The vault's boundary test matches names only, so an `apps/api` file could reach the reveal
  path through a namespace import of `@northstar/gateways`.

## Behavior
- `POST /vault/reveal/options` takes `{ tenantKey }`. Its challenge is stored with that tenant, and
  `POST /vault/reveal` accepts the assertion only for the same tenant (a mismatch is 401 and uses
  the challenge up).
- The boundary test also fails when any `apps/api` file other than `vault-reveal.ts`, its test and
  `bin.ts` imports `@northstar/gateways`. It scans the whole repository (not only `packages`,
  `apps` and `evals`), and `.cjs` and `.jsx` files too. Nothing is added to the reveal allow-list.

## Acceptance criteria
- [x] A challenge issued for one tenant can't reveal another (401, no `vault_access` row).
- [x] The boundary test catches a namespace import of `@northstar/gateways` in another API file.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope (follow-ups)
- The Settings → Accounts "Reveal" button (`apps/web`).
- The `packages/db` items from NS-182's review (a database check on `vault_reveal` decisions, its
  feed line, `withdrawApproval` answering `NotFound`): `packages/db` is held by NS-227 now.

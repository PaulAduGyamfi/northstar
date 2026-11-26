# NS-230: Reveal a vault password to Paul (slice 1: the passkey-checked API route)

Status: approved under ADR-0016 (autonomous lane)
Requirements: CRD-002 · ADR-0010, ADR-0022, ADR-0024
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/api.md` if present, ADR-0016

## Why
Paul sometimes needs to see a tenant password Northstar generated (to sign in by hand). Slice 1
of NS-182 built the vault side (`revealTenantPassword`, a one-time `vault_reveal` approval made
and used in one transaction). Nothing calls it yet. The only caller may be the API, right after a
fresh passkey check.

## Behavior
- `POST /vault/reveal/options` (`auth: "session"`): a WebAuthn assertion challenge for the
  `reveal` ceremony, single use and valid for 60 seconds, user verification required.
- `POST /vault/reveal` (`auth: "session"`), body `{ tenantKey, response }`:
  1. Refused with 429 while the sign-in throttle is engaged, or after 5 reveals in the last minute.
  2. The assertion is checked through `passkeys.ts` (the only importer of the WebAuthn library):
     a known passkey, Northstar's origin and name, user verification, the `reveal` challenge
     (used once, under 60 seconds old), and a sign count that moves forward. A failure is 401 and
     counts toward the sign-in throttle.
  3. With the `vault` kill switch off, 503 `vault_locked` and the key is never loaded.
  4. The master key is loaded from `VAULT_MASTER_KEY_FILE` for this request only, then
     `revealTenantPassword` runs (one `vault_access` row per reveal). A missing password is 404;
     any key or vault fault is 503 `vault_locked` with no detail.
  5. The answer is `{ password }` once, with `Cache-Control: no-store` (as every API answer). The
     password is never logged, put in a span or an event.
- `apps/api/src/vault-reveal.ts` is the one API file the vault's boundary test allows to name
  the reveal path.

## Acceptance criteria
- [x] 401 without a session; a refusal for a stale (over 60 s), missing, reused or
      wrong-ceremony assertion; 503 for a locked vault (switch off) with no key read.
- [x] One `vault_access` row per successful reveal (PGlite).
- [x] The password appears in the response only: never in a span attribute.
- [x] The boundary test allows exactly `apps/api/src/vault-reveal.ts` in the API.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope (follow-ups)
- The Settings → Accounts "Reveal" button and its passkey ceremony in the web app (slice 2).
- Slice 1's review nits on `packages/db` (a database check on `vault_reveal` decisions, its feed
  line, `withdrawApproval` answering `NotFound`) and widening the boundary scan: `packages/db`
  is held by another claim now.

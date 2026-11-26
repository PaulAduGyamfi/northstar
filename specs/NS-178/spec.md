# NS-178: Passkey sign-in for the web app

Status: accepted (autonomous lane, ADR-0016), in slices
Requirements: APR-001, NFR-SEC-* · ADR-0002, ADR-0018 (item 7), ADR-0022 (new)
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #107 (NS-156)

## Why
NS-156 signs Paul in with a random key whose SHA-256 is configured (ADR-0018). System design §2
names a passkey, and ADR-0018 item 7 leaves it, and the fate of the key, to this ticket. A passkey
can't be phished: the browser signs only for Northstar's own name.

## Slices
1. **API and storage (this PR).** ADR-0022, the WebAuthn dependency, the stored credentials and
   the four API endpoints, tested with a fake authenticator.
2. **Web app.** "Sign in with a passkey" on the sign-in page, and "Add a passkey" for a signed-in
   Paul, calling the endpoints below with the browser's `navigator.credentials`.

## Slice 1
1. **ADR-0022.** Passkeys become the primary sign-in. The sign-in key stays as the recovery path
   and is the only way to register the first passkey. The RP ID is the web origin's host name
   (`northstar.localhost`); the expected origin is `NORTHSTAR_WEB_ORIGIN`. User verification is
   required. Challenges live in memory, 5 minutes, single use.
2. **Dependency.** `@simplewebauthn/server`, exact version, at least 14 days old, no install
   script, imported only by `apps/api`.
3. **Storage** (`packages/db`, `passkey-schema.ts`, `passkey-write.ts`): `passkey_credential`
   (candidate, credential id, public key, sign count, transports, created and last used). Rows
   are never deleted. The sign count only moves forward, through `recordPasskeyUse`, which
   refuses a count that doesn't increase (a cloned authenticator), unless both are 0 (as
   platform passkeys report). One migration.
4. **API** (`apps/api/src/passkeys.ts`):
   - `POST /auth/passkey/register/options` and `/register/verify`: session only. Registering
     needs Paul already signed in (by key or passkey).
   - `POST /auth/passkey/sign-in/options` and `/sign-in/verify`: no session. A good assertion
     opens a session exactly like the key does. A bad one counts toward the sign-in throttle and
     answers 401.
   - Each verify consumes its challenge, so a replayed response is refused.
   - Events: `passkey.registered` and `passkey.used`-style facts go on the `api.request` span
     (outcome only); no credential id, public key or challenge in logs, spans or events.

### Acceptance criteria (slice 1)
- [ ] A fake authenticator registers a passkey with a live session, and without one gets 401.
- [ ] That passkey signs in and gets a session cookie; a replayed response, a wrong origin, an
      unknown credential and a non-increasing sign count each get 401 and open no session.
- [ ] Failed passkey sign-ins count toward the throttle.
- [ ] The sign count is stored and only moves forward; credentials are scoped to the candidate.

## Out of scope
Slice 2 (above). Removing a passkey (a later ticket, when there's a settings page).

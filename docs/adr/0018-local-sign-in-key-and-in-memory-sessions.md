# ADR-0018 — Local sign-in key and in-memory sessions for the web app and API

**Status:** Accepted (agent, under ADR-0016) · **Date:** 2026-11-25

## Context
NS-156 adds `apps/web` and `apps/api`. Later tickets put Paul's approval queue (APR-001), the
kill-switch toggles (RES-008) and other decisions behind them. ADR-0002 says only Paul's
authenticated UI path may call `decideApprovals` and `setKillSwitch`, so the app needs to know a
request comes from Paul. System design §2 names a passkey, single user first.

A passkey needs a stored credential (a table, so a migration), and a first registration that
already trusts the browser. Under ADR-0016 item 11 only one agent at a time may add a migration,
and other claimed tickets are changing `packages/db`. Northstar runs on Paul's machine and listens
on 127.0.0.1 only.

## Decision
1. **A sign-in key.** Paul generates a random key (`openssl rand -base64 32`) and keeps it in his
   password manager. `.env` holds only its SHA-256, `NORTHSTAR_SIGNIN_KEY_SHA256` (64 lowercase
   hex). The API refuses to start without it. `POST /auth/sign-in { key }` hashes the key and
   compares it in constant time (`keyMatches`, `apps/api/src/sessions.ts`).
2. **Throttle.** After `THROTTLE_LIMIT` (5) wrong keys within `THROTTLE_WINDOW_MS` (60 s), every
   sign-in gets 429 until the window passes, the right key included.
3. **Sessions in memory.** A sign-in opens a session with a 32-byte random token in the cookie
   `ns_session` (`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, 12 h). The API keeps only
   the token's SHA-256 and its expiry, in a `Map`. Sign-out deletes it, and a restart forgets
   all of them. No `Secure` flag while the app is served over http on loopback. Add it with https.
4. **Request checks** (`apps/api/src/server.ts`):
   - `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise), against DNS
     rebinding.
   - A `POST` with an `Origin` other than `NORTHSTAR_WEB_ORIGIN` gets 403.
   - A `POST` that isn't `application/json` gets 415.
   - `auth: "session"` endpoints answer 401 before reading the body.
5. **One origin for the browser.** The web app rewrites `/api/*` to the API, so the cookie is
   same-site and the web app holds no secret. Its pages ask `GET /me` with the cookie and render
   only for a live session.
6. **Passkeys later.** WebAuthn replaces the sign-in key as the primary method in a follow-up
   ticket, once a migration slot is free. The sign-in key then becomes the recovery path, or
   goes away. That follow-up decides which, in its own ADR.

## Alternatives considered
- **Passkey now:** needs a credential table (a migration, blocked by ADR-0016 item 11), a
  WebAuthn dependency, and a bootstrap secret for the first registration anyway.
- **Password with a stored hash (bcrypt/argon2):** a human-chosen secret needs a slow hash and a
  new dependency. A random 256-bit key needs neither: SHA-256 can't be brute-forced at that size.
- **Signed (stateless) session cookies:** need a second secret (the signing key) and can't be
  revoked one by one. In-memory sessions need no secret and sign-out really ends them.
- **No sign-in, trusting loopback:** any local process or malicious page reaching 127.0.0.1 could
  then approve under Paul's name. ADR-0002 rules that out.

## Consequences
- + One secret, never stored in plain form. A database dump or a leaked `.env` reveals no key.
- + No new dependency and no schema change. The whole flow is plain code with tests.
- − Paul signs in again after every API restart and every 12 hours.
- − A key is weaker than a passkey against phishing. Mitigated by loopback-only serving and the
  same-origin rule. The passkey follow-up closes it.
- − Sessions don't survive more than one API process. Fine for one local user; a hosted
  deployment must revisit this (Q-02).
- Every new endpoint that acts for Paul uses `auth: "session"`, and every new page that shows
  his data goes through the `GET /me` guard (`apps/web/src/session.ts`).

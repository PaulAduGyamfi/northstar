# ADR-0022 — Passkey sign-in, with the sign-in key as the recovery path

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

## Context
ADR-0018 signs Paul in with a random key whose SHA-256 is in `.env`, and leaves passkeys, and what
happens to the key afterwards, to a follow-up (item 7). System design §2 names a passkey. A
passkey can't be phished or typed into the wrong page: the browser signs only for the name it was
registered on. NS-178 adds it. It needs a WebAuthn library (attestation and signature formats are
too easy to get subtly wrong by hand), a credential table and a bootstrap for the first passkey.

## Decision
1. **Passkeys are the primary sign-in.** `apps/api` (`passkeys.ts`) runs the WebAuthn
   registration and sign-in ceremonies with `@simplewebauthn/server` (exact version, at least 14
   days old, no install script). Only `apps/api` imports it.
2. **The sign-in key stays, as recovery and bootstrap.** Registering a passkey needs a live
   session and the sign-in key again, entered with the request (a wrong one counts toward the
   throttle). A passkey outlives any session and can't be removed yet, so a stolen session cookie
   or a script running on the page must not be enough to plant one. If every passkey is lost (a new
   laptop, a wiped phone), the key from Paul's password manager still signs him in and lets him
   register a new one. ADR-0018 items 1–6 are unchanged; this ADR replaces its item 7.
3. **Scope.** The RP ID is the web origin's host name (`northstar.localhost`, ADR-0018 item 4).
   The expected origin is exactly `NORTHSTAR_WEB_ORIGIN`. A different `NORTHSTAR_WEB_ORIGIN`
   means registering passkeys again: a passkey only works on the name it was made for.
4. **Requirements on the authenticator.** User verification is required (a PIN, fingerprint or
   face, not just a tap). Passkeys are discoverable (`residentKey: required`), so sign-in sends no
   allow list. Attestation is `none`: one user registering his own devices gains nothing from a
   vendor's certificate. Accepted algorithms: ES256, EdDSA, RS256.
5. **Challenges** live in memory for 5 minutes and are consumed on first use, so a captured
   response can't be replayed. Registration and sign-in keep separate stores of at most 64 each
   (oldest dropped), so a flood of sign-in requests can't push out a registration in progress.
6. **One session kind, one throttle.** A passkey sign-in opens the same in-memory session as
   the key (ADR-0018 item 3). A failed passkey sign-in counts toward the same 5-a-minute
   throttle (item 2).
7. **Storage.** `passkey_credential` (credential id, COSE public key, sign count at
   registration, transports) and `passkey_use` (one row per sign-in with the reported count), in
   `packages/db` (`passkey-write.ts`), both append-only (triggers). The newest count is the
   largest stored. A sign-in whose count didn't increase is refused (a possible cloned key),
   except that 0 may repeat, because platform passkeys never count. A unique index stops two
   sign-ins from both claiming one non-zero count.
8. **What's recorded.** `passkey.registered` (the row id, "A passkey was added") goes to the feed.
   A sign-in is a span outcome only, as for the key. Credential ids, public keys and challenges
   go nowhere but the store.

## Alternatives considered
- **Drop the sign-in key once a passkey exists:** losing the one device would lock Paul out of
  his own system, with no recovery but editing the database. The key is already in his password
  manager and never stored in plain form.
- **Hand-written WebAuthn verification:** CBOR, COSE and the signature formats are a classic
  place for subtle bugs. A widely used library is safer for one dependency.
- **A session alone for registration:** anything holding the cookie could plant a permanent
  passkey. Asking for the key again costs Paul a paste from his password manager.
- **Mutable sign count column:** simpler, but every other security record here is append-only,
  and a use log shows when each passkey was last used.
- **Direct attestation:** proves the device model, which matters for a fleet, not for one person.

## Consequences
- + A sign-in that can't be phished, with the key kept for recovery.
- + No new secret: a passkey's private key never leaves Paul's device.
- − One new runtime dependency in `apps/api`, which brings 22 packages with it (its ASN.1, x509
  and CBOR helpers, `tsyringe`, `reflect-metadata`), none with an install script.
- − Registering a passkey asks for the sign-in key, so the key stays needed now and then.
- − Passkeys are tied to `northstar.localhost`; changing the origin means registering again.
- − Removing a lost passkey needs a later ticket (a settings page). Until then it stays valid on
  its device, which only Paul holds.
- The web app's buttons come in NS-178's second slice.

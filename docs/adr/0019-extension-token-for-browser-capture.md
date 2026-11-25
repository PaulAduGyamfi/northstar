# ADR-0019 — The browser extension's own token, scoped to its endpoints

**Status:** Accepted (agent, under ADR-0016) · **Date:** 2026-11-25

## Context
NS-128 adds "Save to Northstar" (SRC-002), a Chrome MV3 extension that sends the page Paul is
reading to the API. `.claude/rules/extension.md` says the extension talks only to the Northstar
API, with its own scoped token. ADR-0018 signs Paul in with a key and keeps sessions in an
HttpOnly cookie on the web app's `northstar.localhost` name. The extension runs on a
`chrome-extension://` origin, so it can't use that cookie, and it shouldn't hold the sign-in key.

## Decision
1. **A separate extension token.** Paul generates one the same way as the sign-in key. `.env`
   holds only its SHA-256, `NORTHSTAR_EXTENSION_TOKEN_SHA256`; unset or `change-me` turns the
   extension off. Paul pastes the token into the extension's options, which keep it in
   `chrome.storage.local`.
2. **`auth: "extension"`** in `apps/api` (`server.ts`): `Authorization: Bearer <token>` is hashed
   and compared in constant time (`keyMatches`). It opens only extension endpoints. The session
   cookie isn't read for them, and the token is never checked for a session endpoint.
3. **Origin:** an extension POST must come from `chrome-extension://<32 letters a-p>`. This only
   filters: any installed extension can send such an Origin, so the token is the check.
4. **Endpoints:** only `POST /jobs/capture` today, with a 96 KB body limit (`maxBodyBytes`).
   Everything else keeps 16 KB.
5. **The extension reaches only `http://127.0.0.1/*`.** Its options refuse any other API address,
   so the token never leaves the machine.

## Alternatives considered
- **Reuse the session cookie:** the extension's origin can't send a SameSite=Strict cookie for
  `northstar.localhost`. Loosening SameSite would weaken the web app's CSRF defence.
- **Reuse the sign-in key:** it would put Paul's master key in browser extension storage, and a
  leak would open every session endpoint, including approvals later.
- **Pin the extension id in config:** an unpacked extension's id depends on its folder path, so
  it changes between machines and checkouts. The token already authenticates.

## Consequences
- + A leaked extension token can only capture jobs: no approvals, no kill switches, no reads.
- + The extension can be turned off by leaving the hash unset.
- − Two secrets to manage instead of one. Rotating the token means a new hash in `.env` and a new
  paste in the options.
- Every new extension endpoint uses `auth: "extension"` and states its body limit.

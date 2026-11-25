# ADR-0014 — Gmail read-only access with an in-memory token, no stored credential

**Status:** Proposed · **Date:** 2026-11-25

## Context
NS-113 rebuilds nine months of applications from Paul's Gmail (DX-001) and needs to read mail
(INB-001, INB-002). Reading Gmail needs a Google OAuth token. NFR-SEC-001 requires OAuth tokens to
be encrypted at rest, and the credential vault that would hold them is NS-122, which comes later.
NFR-SEC-002 asks for least-privilege scopes, and Gmail's `gmail.modify` scope can also send mail.
Q-10 defaults to running locally first, with polling; Q-17 accepts reconnecting Gmail weekly.

## Decision
1. `packages/inbox` reads Gmail with scope `https://www.googleapis.com/auth/gmail.readonly` only.
   No other scope is requested in NS-113.
2. Consent uses Google's desktop flow: the authorization-code grant with PKCE (S256) and a
   loopback redirect to `http://127.0.0.1:<random port>`. The local listener accepts one callback,
   checks `state`, and closes after 2 minutes either way.
3. The access token exists only in memory for one run (`funnel backfill`). No refresh token is
   requested (`access_type=online`), and nothing is written to disk, the database, logs, events or
   spans. Each run asks for consent again.
4. The Google OAuth client id and secret come from `.env` (`GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`) through one typed config function. For a desktop client Google
   doesn't treat the secret as confidential, but it is still never printed or logged.
5. Gmail is called with plain `fetch` against the REST API, with no Google SDK dependency.

## Alternatives considered
- **Store the refresh token now, encrypted with a local key:** this would build half of NS-122's
  vault ahead of its ticket, and a second encryption scheme to migrate later.
- **Build the vault first (NS-122), then NS-113:** it delays the funnel diagnosis, which
  13-search-diagnostics calls the first thing the app does, for a backfill that runs rarely.
- **`gmail.modify` now, for labels later:** it can send mail (NFR-SEC-002), and labels are P2
  (INB-005).
- **The `googleapis` package:** a large dependency for three REST calls (list, get, token).

## Consequences
- + No stored Gmail credential exists to leak, so nothing needs the vault yet.
- + The reader can't send, label or delete mail, whatever a bug or a prompt injection tries.
- − Paul clicks through Google's consent screen on every backfill run, which is acceptable for a
  backfill.
- − Continuous inbox work (push, the InboxWorkflow, Verification Catcher) needs a stored refresh
  token. That waits for NS-122 and a new ADR that supersedes point 3.
- We must keep: no token in any log, event, span or printed line, proven by a test.

# NS-237 slice 5: The compose OAuth consent flow

Status: draft (autonomous lane, ADR-0016)
Requirements: RPL-002 · ADR-0025 items 1, 2 and 6 · ADR-0014 (token model)
Rules that apply: ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/tests.md`

## Why
Slice 4 built the Gmail draft writer (`writeReplyDraft`), which needs a `GmailComposeAccess`.
Nothing can make one from a real grant yet. ADR-0025 says the writer gets its own OAuth flow and
token, separate from the read-only mail reader, under ADR-0014's model: desktop PKCE, a token in
memory for one run, and no refresh token.

## Behavior
`authorizeCompose(deps)` in `packages/gateways/src/mail/consent.ts`:
- Runs Google's desktop authorization-code flow with PKCE (S256) and a random `state`. Google
  redirects back to a one-shot listener on `127.0.0.1` (port picked by the OS), which accepts one
  callback, then stops. It times out after `timeoutMs`.
- Requests `https://www.googleapis.com/auth/gmail.compose` only, with `access_type=online`, so it
  gets no refresh token.
- Exchanges the code at Google's token endpoint through the injected `fetchToken`. The scopes come
  from the token response's `scope`, never from configuration (slice 4's review). Then:
  - A grant holding any scope other than `gmail.compose` is refused (`ComposeConsentError`), so
    the writer's token can never read, modify or delete mail.
  - A grant without `gmail.compose`, because the scope isn't on the OAuth client yet (ADR-0025
    item 6), still returns a `GmailComposeAccess` with the scopes granted.
    `hasComposeScope()` is then false, and the writer reports `needs_human` (`scope_missing`)
    without making a request.
- Refuses with `ComposeConsentError`, never quoting a token, code or state, when:
  - the callback's state doesn't match;
  - consent wasn't given (Google's fixed error word only);
  - there's no code, or no access token;
  - it times out;
  - the browser can't be opened.
- `composeTokenEndpoint(fetch)` is the real token endpoint (30 s limit), reporting a non-2xx
  answer by status only.

The flow is written for this module, following `packages/inbox/src/oauth.ts` (the read-only
flow), because `packages/gateways` doesn't depend on `packages/inbox`. The package entry exports
`authorizeCompose`, `composeTokenEndpoint`, `ComposeConsentError` and its deps type. The boundary
test's rules keep applying: no send, update or delete anywhere under `src/mail/`.

## Acceptance criteria
- [ ] The consent URL asks for `gmail.compose` only, with S256 PKCE, `access_type=online` and a 127.0.0.1 redirect (test).
- [ ] The token exchange sends the code, the verifier that matches the challenge and the same redirect URI (test).
- [ ] A grant of exactly `gmail.compose` returns a `GmailComposeAccess` with `hasComposeScope()` true; it prints a mask (test).
- [ ] A grant with any other scope is refused, and so is one with `gmail.compose` plus `gmail.readonly` (tests).
- [ ] A grant without `gmail.compose` returns an access whose `hasComposeScope()` is false (test).
- [ ] A forged state, a refused consent, a missing code, a missing token and a timeout each refuse, and no error message holds the code or token (tests).
- [ ] The listener accepts only one callback (test).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` and `node evals/dist/bin.js --all` pass.

## Failure modes
Google's token endpoint is slow or down: a 30 s limit, then a `ComposeConsentError` naming the
status. Nothing is stored, so a rerun starts over.

## Observability
No events: this is Paul's interactive sign-in, and nothing is written. The caller (#230) records
the draft's own events.

## Out of scope
- The database ledger for drafts (needs a migration).
- The caller after an approval (the worker, #230).
- Settings loading: the caller passes the OAuth client id and secret.

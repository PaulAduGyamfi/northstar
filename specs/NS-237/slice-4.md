# NS-237 (slice 4): The Gmail draft writer, which creates an approved reply as a Gmail draft and never sends it

Status: in progress
Requirements: RPL-002, RES-006 · ADR-0002, ADR-0007, ADR-0014, ADR-0025 (Accepted)
Rules that apply: ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/tests.md`.
Parent: #117, issue #263 (item 2).

## Why
RPL-002: once Paul approves a reply in the queue, the reply should be waiting in Gmail, in the
thread, for him to send himself. ADR-0025 allows a separate writer with `gmail.compose` that
creates drafts and never sends. Slices 1–3 file, show and nudge reply drafts. This slice is the
writer itself, as a Mail Gateway module.

## Behavior
`packages/gateways/src/mail/`:
- **`access.ts`: `GmailComposeAccess`.** The writer's own token type. Each class has its own
  private field, so this token is never the reader's `GmailAccess` and the reverse. It also
  carries the granted scopes. It prints a mask, never the token.
- **`drafts.ts`** (private: not exported from the package, and a boundary test fails if anything
  outside `src/mail/` imports it). It makes two kinds of request, and a runtime allowlist checks
  every request:
  - `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts`, with a body whose only key is
    `message`, holding `raw` and `threadId`;
  - `GET …/users/me/threads/<id>?format=metadata&metadataHeaders=X-Northstar-Approval`, used to
    find a draft left by an unknown outcome.
  Each request goes through the `gmail_drafts` kill switch and the `gmail` breaker. Only a request
  that gets no answer, or a 429 or 5xx, counts against the breaker.
- **`message.ts`: `buildDraftMessage`.** The RFC 5322 message from the stored, approved fields
  only:
  - `To`, `Subject` (RFC 2047 encoded when not ASCII), `In-Reply-To` and `References`;
  - `X-Northstar-Approval: <decision id>`, the marker;
  - a `text/plain; charset=UTF-8` body in base64.

  Header values are checked again with the `ReplyEnvelope` schema, so a control character or a
  line break can't add a header.
- **`gateway.ts`: `writeReplyDraft(ports, access, { candidateId, decisionId, requestId })`.** The
  exported entry point. In order:
  1. It reads the stored draft (`readReplyDraft`). With none it refuses `NotFound`.
  2. It checks the draft with `parseReplyPackage` and re-hashes it with `replyContentSha256`. A
     hash that differs from the stored one is refused (`ContentMismatch`).
  3. It calls `verifyApproval` with kind `email_reply`, the subject from `replySubject(gmail id)`
     and that hash. Without a live approval it refuses `NotApproved` with the Gate's reason. An
     `UndoWindowOpen` refusal carries the window's end as `retryAt`. An approval of another
     request than the one asked for is refused (`RequestMismatch`).
  4. If the grant lacks exactly `https://www.googleapis.com/auth/gmail.compose`, the result is
     `needs_human` (`scope_missing`) and nothing goes to Gmail (ADR-0025 item 6).
  5. It claims the decision in the ledger port: `new`, `done` (with the draft's message id),
     `in_progress` (another run's claim is still within its lease) or `unknown` (an earlier claim
     past its lease with no outcome recorded). The message is built before the claim, so a refused
     build can't leave a claim behind.
     - `done`: the earlier draft is returned and nothing is created.
     - `in_progress`: the `InProgress` refusal with the lease's end. Nothing is created beside the
       other run.
     - `unknown`: it reads the thread, and a `DRAFT` message carrying the marker counts as the
       draft. It records it and returns.
  6. It calls `drafts.create`, then records the message id in the ledger.

  The result is `created`, `already_created` or `needs_human`, or a refusal. Gmail answering with
  an error throws `DraftWriteError`, with the status and Google's reason code only. A held-back
  call is the `HeldBack` refusal, so nothing is sent.

## Acceptance criteria
- [ ] With no verified approval (not found, undone, withdrawn, content changed), nothing reaches
      Gmail, and the result names the Gate's reason.
- [ ] A stored draft whose re-hash differs from its stored hash is refused before the Gate.
- [ ] A grant without `gmail.compose` gives `needs_human` (`scope_missing`) and no request.
- [ ] Two runs for one approval make one draft. A run that finds another run's claim still live
      creates nothing (`InProgress`). After an unknown outcome, a marked draft in the thread is
      found and no second draft is made.
- [ ] An undo-window refusal says when to come back (`retryAt`).
- [ ] The message holds exactly the approved To, Subject, thread headers and body, plus the marker.
      A header value with a line break is refused.
- [ ] The allowlist refuses every other method, URL and body shape.
- [ ] The kill switch and the breaker hold a call back, and Gmail's 429/5xx counts against the
      breaker while a 4xx doesn't.
- [ ] Boundary test: no file under `src/mail/` names a send, update or delete call on drafts or
      messages. No file outside `src/mail/` imports `drafts.ts`, `message.ts` or `access.ts` (the
      package entry may export the token type from `access.ts`), and only `drafts.ts` reads the
      token back (`bearerOf`). The token has no public accessor.
- [ ] `pnpm turbo run lint typecheck test build` is green.

## Failure modes
- Gmail down, slow or rate-limited: `DraftWriteError` (the 30 s timeout counts against the breaker
  too), and the claim stays `unknown`. A retry looks for the marked draft before it creates
  another.
- Breaker open or kill switch off: `HeldBack`, with no request, so the caller retries later.
- Scope missing: `needs_human` (`scope_missing`). The approval view's draft stays the fallback.

## Observability
- Span `gmail.write_reply_draft`, with attributes for the outcome, `held_by` and the HTTP status.
  It never carries an address, subject, body, thread id or token.
- The domain event (`reply.draft_created`, the draft's message id only) comes with the database
  ledger in the next slice, in the same transaction as recording the outcome.

## Out of scope
- The database ledger and its event (needs a migration).
- The compose OAuth consent flow (desktop PKCE, ADR-0014).
- A caller (the worker or the API after an approval).

## Decisions made without Paul
- The draft's id is recorded as the Gmail message id of the draft. `drafts.create` returns both
  ids, and the thread read after an unknown outcome gives the message id, so one id works for both
  paths.
- The gateway takes its ports as an interface (`MailPorts`). The database adapter comes with the
  ledger, which must give `in_progress` for a claim younger than its lease (longer than the 30 s
  request timeout) and `unknown` after it.
- The diff is over ~300 lines: about 500 lines of code plus tests. It stays one slice because
  the token type, allowlist, message builder and entry point only make sense together, and the
  boundary test covers them as one unit.

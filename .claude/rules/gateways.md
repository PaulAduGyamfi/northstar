---
paths:
  - "packages/gateways/**"
  - "packages/ats-adapters/**"
  - "packages/sources/**"
---

# Action gateways, ATS adapters and job sources (ADR-0002, ADR-0003, ADR-0007)

`packages/sources` exists since NS-114 (link ingest: `fetch.ts`, `ats/`, `jsonld.ts`,
`terms.ts`). The Apply Gateway is `packages/gateways` (NS-120); its ATS adapters live in
`src/apply/adapters/`, not a separate `packages/ats-adapters`. The Mail Gateway's draft writer
(NS-237 slice 4, ADR-0025) is `src/mail/`: `writeReplyDraft` creates an approved reply as a
Gmail draft and never sends. Only `src/mail/` imports `drafts.ts`, `message.ts` or `access.ts`
(the package entry may export the token type), and nothing there names a send, update or delete
on drafts or messages (its boundary test and the runtime `requestAllowed`). Never widen either,
never hand its `GmailComposeAccess` to code that reads mail, and claim the decision in the
ledger before `drafts.create`. Other gateways (calendar, GitHub) don't exist yet: if you are
about to create one outside its ticket, stop and ask Paul.
The Gmail label writer (NS-229, `packages/inbox/src/labels/`, ADR-0027 **Rejected**: no caller,
no code may request `gmail.modify`) only adds
Northstar's fixed labels: never widen it to send, trash, remove or draft (its boundary test),
and never hand its `gmail.modify` token to code that reads mail.

- Every submission goes through `submitApplication`: the apply URL's host must be the ATS's own
  and the posting id must match the one in the URL, then the Gate check (throws
  `NotApprovedError`), a re-hash of the files, `claimSubmission`, a `FormDriver` with time limits,
  then proof. After the files it asks `isPostingClosed` (NS-218): a closed posting is the
  `PostingClosed` refusal, nothing claimed. Before the claim it asks the `auto_apply` and `adapter:<ats>` switches and the
  `ats:<ats>` breaker (NS-206, `guard.ts`); held back is the `HeldBack` refusal with nothing
  claimed, so a later call retries. After the browser step only a timeout counts against the
  breaker, a page the ATS served is it working, and a browser crash isn't reported. A live claim
  is never touched (`InProgress`). A claim older than 15 minutes becomes
  `needs_human` (`outcome_unknown`) and is never retried; `closeStaleClaim` (`stale.ts`) does
  that for both a repeated call and `sweepStaleClaims` (NS-143). The sweep also finishes the
  move of a claim the ledger closed but whose application never followed (NS-177,
  `listHalfClosedClaims`), with the same keys. Status moves use the
  `application:<id>:apply:<submissionId>:<to>` key namespace (`applyMoveKey`). Pacing limits
  are an `ApplyLimits` from `loadApplyLimits`, given to `dbPorts`; never per call.

- The handoff pre-fill (NS-192) reads the approved package only through `readHandoffPackage`
  (`packages/db`). It re-checks the handoff (open, the candidate's), the approval
  (`verifyApproval` for the stored package's subject and hash) and the package's own hash on every
  read. ADR-0029 (Accepted, option 2) allows serving it only with a one-time, 2-minute grant from
  Paul's own session plus the extension token; never on the token alone, and never widen that.
  Since slice 2 the API's `prefill.ts` is that one place: it consumes the grant before any read. Never hand a package to the browser
  from anywhere else, never trust a package the caller sends, and never put a field value in a
  span, log, event or error. The extension fills; it never submits or touches the challenge
  (ADR-0003).

- The browser driver (NS-142, ADR-0028) lives in `src/apply/browser/`. Only `launch.ts`
  imports `playwright-core`, and it never downloads a browser: the worker passes the installed
  one's path. The driver only reports what it sees: a challenge is never solved, and there is no
  stealth or fingerprint change. It stays on the adapter's hosts, and after `close()` it takes no
  further browser action. Its tests run on the fake page and stand-in DOM in
  `src/apply/browser/test/`, never a live site.

- The credential vault (NS-122, ADR-0010) is sealed and opened only in `src/vault/`. Never export
  `src/vault/open.ts` from the package or import it from outside `packages/gateways/src` (a
  boundary test enforces this, CRD-002, as it does for `createDecipheriv`, the master key's bytes
  (`keyBytes`) and `vault_secret`). Call `useTenantPassword` only after `verifyApproval` for
  the action it serves, keep the result a `VaultSecret`, and `reveal()` it only where the browser
  types it.
  Paul's own reveal (NS-182, ADR-0024) goes only through `revealTenantPassword`, the one opening
  the package exports. It makes its own approval, so its caller must be the API after a fresh
  passkey check; the boundary test lists the only files that may name it. Since NS-230 the one
  API file is `apps/api/src/vault-reveal.ts`; adding any other needs Paul's approval. Since
  NS-245 its passkey challenge is bound to the tenant it was issued for, and no other `apps/api`
  file but its test and `bin.ts` may import `@northstar/gateways` (the boundary test).

- Employer accounts (NS-124): before creating an account on a tenant, register it
  (`registerTenant`) and call `beginAccountCreation`. Only the caller it returns `creating` to may
  create one; `AlreadyStarted` means sign in or wait (ACC-006). Decide every notice with
  `decideConsent` and keep each accepted one with `recordConsent` (ACC-008).

- Every page fetch goes through `safeFetch` (https only, public addresses on every redirect,
  2 MB, 15 s). Never call `fetch` on a pasted link directly. Whole-board listings (NS-115,
  `boards/list.ts`) pass `BOARD_MAX_BYTES` (10 MB); nothing else does.
- Board polling (`poll.ts`) never throws for one board: a failure is that board's result, it
  backs off, and after 5 failures it is quarantined until Paul retries it (RES-002/003).
  Before each read it checks the `source:<ats>` kill switch and breaker (NS-147); a board held
  back is not recorded and stays due. Only the board read reports to the breaker, never a save.

For every gateway (the Apply Gateway now, the others when they land):

- A gateway calls `verifyApproval` (NS-119) at the moment it acts, never when it enqueues, and
  passes the SHA-256 of exactly what it is about to send. One approval, one send: the Apply
  Gateway keys each submission `application:<id>:submit` and refuses a second one for the same
  requisition. An `UndoWindowOpen` refusal becomes a scheduled retry at `effective_at`
  (ADR-0007), never a silent drop. Since NS-211 the Apply Gateway answers the Gate's
  `ContentChanged` (and nothing else, never its own transient `FileChanged`) by withdrawing the
  approval: `requestOfDecision`, then `withdrawApproval({ by: "gateway", newContentSha256 })`,
  then it still throws. It writes no ledger row (that would block the resubmission); the
  `approval.withdrawn` feed line is the visible item, and a refused withdrawal is on the span,
  so the caller must surface the thrown `NotApprovedError`. When the refusal is the approval's
  open undo window (NS-234), the error's `retryAt` is the window's end: the caller comes back
  then (the worker waits it out), never drops it.
- A gateway call without a verified `approvalId` or `policyDecisionId` throws. Look the approval
  up server-side; never trust an ID the caller merely asserts. Test the refusal.
- Every side effect has an idempotency key (`application:{id}:submit`, `email:{draftId}:send`).
  A retry after a crash must not double-submit or double-send; prove it with a test.
- Timeouts, jittered retries and a circuit breaker per dependency (each ATS domain, Gmail,
  Calendar, GitHub). Breaker state shows up in the health model.
- Adapters fail into quarantine and assisted apply, never into a silent drop.
- No CAPTCHA solving, stealth plugins, fingerprint spoofing or credential storage. A challenge
  returns `needs_human` with a deep link. The Apply Gateway passes the package's apply URL to
  `recordNeedsHuman`, which opens a handoff for Paul on a challenge reason (NS-121).
- Human pacing: one submission at a time per ATS domain, with daily caps.
- Job sources declare their terms status (`official-api`, `public-feed`, `user-session-capture`,
  `prohibited`). `prohibited` can't be enabled.
- Tests run against recorded fixtures of ATS pages and APIs, never the live site.

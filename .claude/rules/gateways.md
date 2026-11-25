---
paths:
  - "packages/gateways/**"
  - "packages/ats-adapters/**"
  - "packages/sources/**"
---

# Action gateways, ATS adapters and job sources (ADR-0002, ADR-0003, ADR-0007)

`packages/sources` exists since NS-114 (link ingest: `fetch.ts`, `ats/`, `jsonld.ts`,
`terms.ts`). The Apply Gateway is `packages/gateways` (NS-120); its ATS adapters live in
`src/apply/adapters/`, not a separate `packages/ats-adapters`. Other gateways (mail, calendar,
GitHub) don't exist yet: if you are about to create one outside its ticket, stop and ask Paul.

- Every submission goes through `submitApplication`: the apply URL's host must be the ATS's own
  and the posting id must match the one in the URL, then the Gate check (throws
  `NotApprovedError`), a re-hash of the files, `claimSubmission`, a `FormDriver` with time limits,
  then proof. A live claim is never touched (`InProgress`). A claim older than 15 minutes becomes
  `needs_human` (`outcome_unknown`) and is never retried; `closeStaleClaim` (`stale.ts`) does
  that for both a repeated call and `sweepStaleClaims` (NS-143). Status moves use the
  `application:<id>:apply:<submissionId>:<to>` key namespace (`applyMoveKey`). Pacing limits
  are an `ApplyLimits` from `loadApplyLimits`, given to `dbPorts`; never per call.

- The credential vault (NS-122, ADR-0010) is sealed and opened only in `src/vault/`. Never export
  `src/vault/open.ts` from the package or import it from outside `packages/gateways/src` (a
  boundary test enforces this, CRD-002, as it does for `createDecipheriv`, the master key's bytes
  (`keyBytes`) and `vault_secret`). Call `useTenantPassword` only after `verifyApproval` for
  the action it serves, keep the result a `VaultSecret`, and `reveal()` it only where the browser
  types it.

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
  requisition. A `ContentChanged` or `UndoWindowOpen` refusal becomes a
  visible `needs_human` item or a scheduled retry at `effective_at` (ADR-0007), never a silent drop.
- A gateway call without a verified `approvalId` or `policyDecisionId` throws. Look the approval
  up server-side; never trust an ID the caller merely asserts. Test the refusal.
- Every side effect has an idempotency key (`application:{id}:submit`, `email:{draftId}:send`).
  A retry after a crash must not double-submit or double-send; prove it with a test.
- Timeouts, jittered retries and a circuit breaker per dependency (each ATS domain, Gmail,
  Calendar, GitHub). Breaker state shows up in the health model.
- Adapters fail into quarantine and assisted apply, never into a silent drop.
- No CAPTCHA solving, stealth plugins, fingerprint spoofing or credential storage. A challenge
  returns `needs_human` with a deep link.
- Human pacing: one submission at a time per ATS domain, with daily caps.
- Job sources declare their terms status (`official-api`, `public-feed`, `user-session-capture`,
  `prohibited`). `prohibited` can't be enabled.
- Tests run against recorded fixtures of ATS pages and APIs, never the live site.

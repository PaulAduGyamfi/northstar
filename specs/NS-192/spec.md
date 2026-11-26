# NS-192: Pre-fill a handed-off form: the package store and the extension endpoint (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: APPLY-006, ACC-007 · ADR-0002, ADR-0003, ADR-0012, ADR-0019
Rules that apply: `.claude/rules/tests.md`, `.claude/rules/gateways.md`, `.claude/rules/db.md`.
Issue #161 (Parent: #20).

## Why
When a CAPTCHA, sign-in or verification step stops a submission, Paul finishes the form by hand
from the "Needs your hands" card (NS-121). The extension should fill that form with what he
already approved. But the approved package is stored nowhere: the Gate keeps only its hash, and
the package travels in the worker's input. This slice stores it and adds the read the extension
will use. The extension's fill is slice 2.

## Behavior
- **The package store.** A new append-only table, `application_package`, holds one row per
  `application_package` Gate request: the package's JSON and its SHA-256.
  - A foreign key pins each row to its request's id, candidate, kind and content hash, as
    `reply_draft` does, so a row can only sit behind a request that approved exactly that content.
  - `requestPackageApproval` (the Gate's entry for packages) requests approval and stores the
    package in one transaction. A replay of the same filing stores nothing new.
- **The read.** `readHandoffPackage(db, candidateId, handoffId)` (`packages/db`) gives one open
  handoff's approved package, or says why not:
  - `NotFound`: no such handoff for this candidate, so another candidate's handoff reads as
    absent;
  - `Closed`: Paul already said "I submitted it" or "I gave up";
  - `NoPackage`: the package was filed before this store existed;
  - `NotApproved`: the approval behind the submission doesn't verify now (`verifyApproval`, with
    the stored package's subject and hash);
  - `Changed`: the stored package no longer hashes to its pinned SHA-256.

  Otherwise it returns the apply URL, ATS, contact and form fields: never the files, which come in
  slice 2.
- **The endpoint.** `POST /handoffs/package` (`apps/api`, `auth: "extension"`), with input
  `{ handoffId }`:
  - It answers with the read's fields, or 404 for `NotFound`, 409 for `Closed`, `NoPackage`,
    `NotApproved` or `Changed`, with the reason code only.
  - A session cookie never opens it: only the extension's own token does.
  - It never logs or puts a field value on a span.

## Acceptance criteria
- [ ] Filing a package stores it in the same transaction, and a replay stores nothing new
  (PGlite).
- [ ] The database refuses a row whose request has another kind, candidate or hash, and refuses
  update and delete.
- [ ] `readHandoffPackage` returns the package for an open handoff, and `NotFound` (another
  candidate), `Closed`, `NoPackage`, `NotApproved` and `Changed` otherwise (PGlite).
- [ ] The endpoint answers only with the extension token: 401 with a session cookie alone. It
  maps each refusal to its status (fake ports).
- [ ] AGENTS.md, `.claude/rules/gateways.md` and the db rules describe the store and the endpoint.

## Failure modes
- A package filed before this migration has no stored row: `NoPackage` (409). Paul fills the form
  by hand as today.
- The database is down: the endpoint answers 500, and nothing is filled.

## Observability
No new events: a read changes nothing. Slice 2's fill writes `handoff.prefilled`. The request's
`api.request` span carries the status and the reason code only.

## Out of scope
- The extension's fill, files, and the `handoff.prefilled` event (slice 2).
- Reading the package back for the worker (#277).

## Open questions
None.

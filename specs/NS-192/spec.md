# NS-192: Pre-fill a handed-off form: the package store (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: APPLY-006, ACC-007 · ADR-0002, ADR-0003, ADR-0012, ADR-0019, ADR-0029 (Proposed)
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
- **No endpoint yet.** Serving the package to the extension on its own token would change
  ADR-0019 (Accepted), whose consequence is "a leaked extension token can only capture jobs: no
  approvals, no kill switches, no reads". An agent mustn't widen an accepted credential alone, so
  ADR-0029 (Proposed) puts three options to Paul: a read on the token, a one-time grant from his
  session, or no extension read. #317 (NS-253, `needs:paul`) tracks it. The endpoint comes after his
  choice.

## Acceptance criteria
- [ ] Filing a package stores it in the same transaction, and a replay stores nothing new
  (PGlite).
- [ ] The database refuses a row whose request has another kind, candidate or hash, and refuses
  update and delete.
- [ ] `readHandoffPackage` returns the package for an open handoff, and `NotFound` (another
  candidate), `Closed`, `NoPackage`, `NotApproved` and `Changed` otherwise (PGlite).
- [ ] ADR-0029 (Proposed) records the extension-read choice, and a `needs:paul` issue asks for
  it.
- [ ] AGENTS.md and the db, gateways and extension rules describe the store, and say the endpoint
  waits on ADR-0029.

## Failure modes
- A package filed before this migration has no stored row: `NoPackage` (409). Paul fills the form
  by hand as today.
- The database is down: filing the package fails as a whole (the request rolls back too), and the
  pipeline's caller retries it.

## Observability
No new events: storing the package rides on the Gate's own `approval.requested`, and a read
changes nothing. The read's `db.apply.handoff_package` span carries the outcome kind only. The
later fill writes `handoff.prefilled`.

## Out of scope
- The extension's fill, files, and the `handoff.prefilled` event (slice 2).
- Reading the package back for the worker (#277).

## Open questions
None.

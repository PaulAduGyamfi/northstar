# NS-242: Keep the application package out of the submission workflow's Temporal history

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #277 (parent #231)
Requirements: RES-001, RES-005 · ADR-0001, ADR-0002
Rules that apply: `.claude/rules/worker.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`,
AGENTS.md ("This repo is public", "Safe to repeat", "Fail small")

## Why
`SubmissionInput.package` and the `submitApplication` activity's arguments carry the whole
application package: Paul's contact name, email and phone, and his answers. Temporal keeps workflow
inputs and activity arguments as plain text in its history, and its UI shows them. This must close
before a worker process runs the workflow (#230).

## Choice
Pass ids only (the issue's first option). No payload codec and no ADR: the package is already
stored in `application_package` (NS-192), behind the Gate request its decision approved, so the
activity can load it there. A codec would add a key to manage for no gain.

## Behavior
- `SubmissionInput` is `{ candidateId, applicationId, packageSha256 }`. The activity's arguments
  are `{ candidateId, applicationId, decisionId, packageSha256 }`. Neither has a package field.
- `inputProblem` checks the workflow input before it waits for the Gate: `candidateId` and
  `applicationId` are uuids, `packageSha256` is 64 lowercase hex, and the input has no other key.
  A `package` key (or any field of one) is refused, so a caller that still sends one fails at once.
- The activity checks its arguments the same way (no other key, ids and hash in shape), then
  loads the package through a port bound to `readDecisionPackage` (`packages/db`), then calls the
  gateway with it as before. The gateway still checks the approval itself (ADR-0002).
- `readDecisionPackage(db, candidateId, { decisionId, applicationId, contentSha256 })` reads the
  package stored behind the request that decision decided, for this candidate. It refuses:
  - `NoPackage`: no package stored behind that decision (another candidate's reads the same);
  - `Mismatch`: the stored package's hash isn't `contentSha256`, it no longer parses or re-hashes
    to its stored hash, or its `applicationId` isn't the one given.
  It never puts a field value in a span, error or event.
- A refusal ends the run without retry as `not_approved` with reason `NoPackage` or
  `PackageMismatch`, recorded by NS-226's dead letter as `not_approved_no_package` /
  `not_approved_package_mismatch`. Both join the reason allowlist (renamed `NOT_APPROVED_REASONS`:
  the Gate's kinds plus these two). A database error is thrown and retried.
- Because the reader hands out only the package the Gate pinned, the gateway's `ContentChanged`
  handling (NS-211's withdrawal, NS-234's wait) can't happen through this workflow any more. A
  workflow started with another hash ends as `PackageMismatch` and the approval stays live; that
  is safe, since it covers only the stored package. The wrapper's mapping for it stays for other
  callers.
- No `patched` versioning: no worker process runs this workflow yet (#230), so nothing is in
  flight with the old input.
- A Temporal reset: the reset run has a new run id, so an ending already recorded files a second
  dead letter. That letter is visible, never hidden, but it is a duplicate; noted in
  `endingKey`'s comment and `.claude/rules/worker.md`, not handled here.

## Acceptance criteria
- [x] The workflow's input and the activity's arguments hold no package fields, with tests that
      fail if one comes back (`inputProblem` and the activity refuse a `package` key).
- [x] The activity refuses a package whose hash doesn't match (`readDecisionPackage` on PGlite,
      and the activity on a fake port).
- [x] `inputProblem` refuses a bad `candidateId`.
- [x] lint, typecheck, test and build green for `@northstar/worker` and `@northstar/db`.

## Out of scope
- The worker process, the client helper and the activity's real port binding (#230).
- A payload codec.

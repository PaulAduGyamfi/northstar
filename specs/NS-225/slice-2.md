# NS-225 slice 2: start the workflows and relay the Gate's decisions

Status: built (autonomous lane, ADR-0016). Slice 1 (the process) merged in #382; see `spec.md`.
Issue: #230 (parent #108)
Requirements: RES-001, RES-005, RES-006 · ADR-0001, ADR-0002

## Why
The worker runs, but nothing starts its workflows. A submission needs a workflow per package round
and the Gate's decision as a signal; the stale-claim sweep needs to run whenever the worker does.

## Behavior
- `src/client.ts`, plain code over a narrow `TemporalPort` (tested with a fake), bound to
  Temporal's Client by `temporalPort` (every workflow on the `pipeline` queue; tested with a fake
  client throwing Temporal's own error classes):
  - `startSubmission(port, input)`: checks the input with `inputProblem` (ids and the hash only,
    NS-242), then starts `submissionWorkflow` as `submission:<applicationId>:<packageSha256>`
    with `REJECT_DUPLICATE` and conflict `FAIL`: a second start for the same package round starts
    nothing (`AlreadyStarted`), while a new round (after Paul rejected a package, NS-227's
    `preparePackage`, or a changed one was withdrawn, NS-211) gets its own run. Temporal refuses a
    reused id only while it keeps the closed run (the namespace's retention): the Apply Gateway's
    claim is what stops a second submission (RES-006), never the workflow id.
  - `signalApproval(port, round, decisionId)` and `signalWithdrawn(port, round)`, where a round is
    `{ applicationId, packageSha256 }`: ids and the hash checked, sent to that round's workflow;
    `NotRunning` when none runs, so a new round's approval never reaches an older round's run. A
    rejected round's caller sends `withdrawn`, so its run ends instead of waiting for ever. A
    retried signal is harmless: the workflow keeps the first decision.
  - `ensureStaleSweep(port, { candidateIds })`: starts `staleClaimSweepWorkflow` as
    `stale-claim-sweep` with conflict `USE_EXISTING` (Temporal doesn't say whether it started one
    or kept the running one, so it returns nothing). A running sweep keeps its first candidate
    ids, which is right for one candidate (Q-02).
- `main.ts` ensures the sweep at start, for the one candidate (`soleCandidate`, Q-02, which creates
  the candidate row on an empty database, as the CLIs do), before the pools run. A failure stops
  the worker with its one error line; a close error never hides it.
- Start and signal use the client's own gRPC retries and the connection's timeout, with no extra
  deadline: accepted for a Temporal on this machine (RES-005).
- Exported from `@northstar/worker` for the callers that file packages and relay decisions; none
  calls `startSubmission` or the signals yet (the package step's caller and the Queue's decide
  path come with their tickets).
- `@temporalio/client@1.25.0` becomes a direct dependency (approved by the orchestrator; already in
  the lock file at that version, only the importers entry changes).

## Known limit
- A round Paul withdrew and then re-requested with exactly the same package has the same hash, so
  `startSubmission` answers `AlreadyStarted` while Temporal keeps the first run. A caller that
  needs it must change the round's key (for example the package id), recorded for that caller's
  ticket.

## Acceptance criteria
- [x] One workflow per package round: a second start, during or after the first run, starts
      nothing; a new round starts its own; the start carries exactly the three input fields.
- [x] A start with a package field is refused before Temporal is called.
- [x] Signals carry the decision id (approval) or nothing (withdrawn), refuse ids and hashes out of
      shape, say `NotRunning` when no workflow runs, and never reach another round's run.
- [x] `ensureStaleSweep` starts the one sweep under its fixed id with `USE_EXISTING`.
- [x] `temporalPort`: the policies and queue it passes, Temporal's already-started and not-found
      errors read as "not started" / "not running", any other error rethrown.
- [x] lint, typecheck, test and build green for `@northstar/worker`; docs updated.

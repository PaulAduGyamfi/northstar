# NS-225 slice 2: start the workflows and relay the Gate's decisions

Status: built (autonomous lane, ADR-0016). Slice 1 (the process) merged in #382; see `spec.md`.
Issue: #230 (parent #108)
Requirements: RES-001, RES-006 · ADR-0001, ADR-0002

## Why
The worker runs, but nothing starts its workflows. A submission needs a workflow per application
and the Gate's decision as a signal; the stale-claim sweep needs to run whenever the worker does.

## Behavior
- `src/client.ts`, plain code over a narrow `TemporalPort` (tested with a fake), bound to
  Temporal's Client by `temporalPort` (every workflow on the `pipeline` queue):
  - `startSubmission(port, input)`: checks the input with `inputProblem` (ids and the hash only,
    NS-242), then starts `submissionWorkflow` as `submission:<applicationId>` with
    `REJECT_DUPLICATE` and conflict `FAIL`: a second start for the same application, even after
    the first run ended, starts nothing (`AlreadyStarted`). Safe to repeat (RES-006).
  - `signalApproval(port, applicationId, decisionId)` and `signalWithdrawn(port, applicationId)`:
    uuids checked, sent to that application's workflow; `NotRunning` when none runs.
  - `ensureStaleSweep(port, { candidateIds })`: starts `staleClaimSweepWorkflow` as
    `stale-claim-sweep` with conflict `USE_EXISTING`, so a restart keeps the running sweep.
- `main.ts` ensures the sweep at start, for the one candidate (`soleCandidate`, Q-02), before the
  pools run. A failure stops the worker with its one error line.
- Exported from `@northstar/worker` for the callers that file packages and relay decisions; none
  calls `startSubmission` or the signals yet (the package step's caller and the Queue's decide
  path come with their tickets).
- `@temporalio/client@1.25.0` becomes a direct dependency (approved by the orchestrator; already in
  the lock file at that version, only the importers entry changes).

## Acceptance criteria
- [x] One workflow per application: a second start, during or after the first run, starts
      nothing; the start carries exactly the three input fields.
- [x] A start with a package field is refused before Temporal is called.
- [x] Signals carry the decision id (approval) or nothing (withdrawn), refuse non-uuids, and say
      `NotRunning` when no workflow runs.
- [x] `ensureStaleSweep` starts the one sweep and keeps a running one.
- [x] lint, typecheck, test and build green for `@northstar/worker`; docs updated.

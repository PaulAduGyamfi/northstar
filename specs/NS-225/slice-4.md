# NS-225 slice 4: heartbeats for the browser steps

Status: built (autonomous lane, ADR-0016). Slices 1–3 merged in #382, #385, #391; see `spec.md`.
Issue: #230 (parent #108)
Requirements: RES-005 · ADR-0001, ADR-0002, ADR-0007

## Why
The `submitApplication` activity has a 10-minute start-to-close timeout. A worker that dies in the
middle of a browser step is noticed only when that runs out. With heartbeats, Temporal notices in
about a minute, and the retry finds the gateway's claim (`InProgress`, then `outcome_unknown`
after 15 minutes), so nothing is submitted twice.

## Behavior
- The Apply Gateway's ports take an optional `onStep(step)` (`packages/gateways`, `ports.ts`,
  `ApplyStep`: `open`, `submit`, `close`), called as each browser step starts in `drive`
  (`close` also after a failure). It only reports: it is never passed a field value, URL or page,
  and a hook that throws is ignored (`stepReporter`), so the submission is the same with or
  without it. `dbPorts` passes it through.
- The worker's `submitApplication` activity (`createApplyActivities`' new `beat` argument) beats
  the current step at once (`load`), on every step the gateway reports, and every 20 s
  (`BEAT_MS`) until the call ends, success or failure. A beat that can't be sent is ignored.
- `workerActivities` binds `beat` to Temporal's `Context.current().heartbeat(step)`; the step name
  is the only heartbeat detail.
- `submissionWorkflow` gives the activity a 1-minute `heartbeatTimeout`: three missed beats.
- `@temporalio/activity@1.25.0` becomes a direct dependency of `apps/worker` (approved by the
  orchestrator; already in the lock file at that version, importers entry only).
- No workflow versioning (`patched`): nothing starts submission workflows yet, so none is in
  flight with the old activity options.

## Acceptance criteria
- [x] The gateway reports open, submit and close in order; open and close only for a challenge;
      a throwing hook changes nothing.
- [x] The activity beats at once, on each step and every 20 s during a long step, stops when the
      call ends (also on failure), and submits the same when a beat can't be sent.
- [x] The workflow has a 1-minute heartbeat timeout; the bundle still builds.
- [x] lint, typecheck, test and build green for `@northstar/worker` and `@northstar/gateways`;
      docs updated.

## Out of scope
- Cancelling a browser step when Temporal cancels the activity (heartbeat-driven cancellation).

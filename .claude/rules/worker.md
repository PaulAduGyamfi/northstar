---
paths:
  - "apps/worker/**"
  - "packages/domain/**"
---

# Temporal workers and the domain (ADR-0001, ADR-0007)

`apps/worker` exists since NS-157: the `pipeline` and `apply-browser` queues (`src/queues.ts`),
`submissionWorkflow` and its plain `decide` step (`src/workflows/`), and the Apply Gateway
activity (`src/activities/apply.ts`); since NS-220 the stale-claim sweep (`src/workflows/sweep.ts`,
`src/activities/sweep.ts`); since NS-226 a submission's ending that only Temporal's history
would show becomes a dead letter (`src/workflows/ending.ts`, `src/activities/ending.ts`). Workflow code may import only `@temporalio/workflow`, plain
code and type-only imports: the bundle test (`bundleWorkflowCode`) fails otherwise. Since NS-225 (slice 1) the worker process: `src/main.ts`
(entry `src/bin.ts`, the only file that reads `process.env`), its settings in `src/config.ts`
(`loadWorkerConfig`) and the bound activities in `src/wiring.ts` (`workerActivities`); since
slice 2 the client helper `src/client.ts` (start a submission once per package round, relay the
Gate's decision as a signal, ensure the one sweep). The workflow id is not the double-submit
guard (Temporal forgets closed runs after retention): the Apply Gateway's claim is, so never drop
it trusting the id. Since slice 3 each pool beats every 30 s (`src/heartbeat.ts`) into
`worker_heartbeat`, which Health reads; a new queue beats too (add it to the table's CHECK and
`WORKER_QUEUES`). Since slice 4 the submit activity heartbeats Temporal every 20 s and on each
browser step (2-minute `heartbeatTimeout`; the gateway's claim, not the timeout, stops a second
submission); a heartbeat carries the step name only, never a
value. Since NS-213 slice 2 the package decision relay (`src/workflows/relay.ts`,
`src/activities/relay.ts`) signals waiting submission runs from `readPackageSignals`: only
decisions past their undo window, and only runs whose `waiting` query says they still wait.
Since NS-193 slice 3 the handoff notifier (`src/workflows/notify.ts`, `src/activities/notify.ts`,
ports in `src/notify-ports.ts`) pushes each new open handoff once: it claims before it sends,
claims nothing while `push` is off or no browser listens, reports a claim with no result as a dead
letter instead of re-sending, and `main.ts` starts it only while the `PUSH_VAPID_*` settings are
set (its activities stay registered, so a notifier started earlier does nothing when they're not).
Since NS-199 item 1 slice 2 the same pass also pushes fresh-job alerts after the handoffs, read
only through `readFreshAlertsToNotify` (never a held alert, never one over an hour old) and
claimed through `claimFreshJobNotification`; a stale claim's dead-letter subject comes from its
key (`apply_handoff:<id>` or `job:<id>`), and a key of an unknown kind is never guessed into one.
Other domains' workflows arrive with their tickets.

Rules:

- A pool's concurrency comes only from `loadPoolLimits` (`src/pools.ts`, NS-219) through
  `workerOptions`; a new queue gets its own setting and ceiling there.
- Workflow code is deterministic: no `Date.now()`, `Math.random()`, network, file or database
  access in workflows. Use Temporal APIs (`sleep`, `condition`, signals) and do I/O in activities.
- One task queue and worker deployment per domain (`sourcing`, `pipeline`, `apply-browser`,
  `inbox`, `outreach`, `calendar`, `profile`, `growth`, `llm`). Don't add work to another
  domain's queue.
- Human approvals are signals. Waits are durable timers. Never poll in a loop.
- Activities have start-to-close timeouts and retry policies. Long browser sessions heartbeat.
- Every state change emits a domain event (outbox) and carries the trace context.
- Application status moves only through the state machine in `docs/requirements/03-auto-apply.md`.
- Changing a running workflow's code needs versioning (`patched`), or in-flight workflows break.
- A workflow ending that leaves no `needs_human` item or feed line records a dead letter through
  an activity (never from workflow code), keyed so a retry stores one, and still fails visibly.
- Workflow inputs and activity arguments are kept in plain text in Temporal's history: pass ids
  and hashes, never personal data (NS-242). The submission's input is `candidateId`,
  `applicationId` and `packageSha256` only, and its activity loads the package from storage.
- A Temporal reset gives the run a new run id, so an ending already recorded files a second dead
  letter (`endingKey`): a visible duplicate, not handled.
- The worker connects only to a Temporal on this machine (`TEMPORAL_ADDRESS` is loopback only; no
  TLS), and the `apply-browser` pool starts only with `WORKER_APPLY_BROWSER=on` (default off).
  Never default it on or start it some other way: off is how Paul keeps anything from being
  submitted. A pool gets only its own activities (`workerActivities`).

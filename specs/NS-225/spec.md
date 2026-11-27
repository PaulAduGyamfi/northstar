# NS-225: The worker process (slice 1: connect to Temporal and run the pools)

Status: in progress (autonomous lane, ADR-0016). Assigned by the orchestrator; the "Blocked by
#76" line was lifted by the decision recorded on #230 (the driver exists; what's left on #76 is
Paul's real submission).
Issue: #230 (parent #108)
Requirements: RES-001, RES-005, APPLY-007 · ADR-0001, ADR-0002, ADR-0003, ADR-0007, ADR-0028
Rules that apply: `.claude/rules/worker.md`, `.claude/rules/gateways.md`, `.claude/rules/db.md`,
`.claude/rules/tests.md`, AGENTS.md ("Approval is architecture", "Fail small", "Secrets")

## Why
`apps/worker` has the queues, `submissionWorkflow`, the stale-claim sweep and their activities,
but no process runs them. Nothing in Northstar happens on its own until one does.

## Slices
1. **This slice: the process.** Typed settings, a deferred browser driver, the activities bound
   to the database, and `main.ts`, which connects to Temporal and runs one worker per queue.
2. The client helper: start `submissionWorkflow` as `submission:<applicationId>` (a second run for
   the same application refused) and send the `approval` / `withdrawn` signals.
3. Worker health (running, last poll) in `systemHealth`, so Health shows a stopped pool (needs a
   table: a migration, asked of the orchestrator first).
4. Heartbeats for the browser steps, once the gateway has a step hook.

## Behavior (slice 1)
- `loadWorkerConfig(env)` (`src/config.ts`), the one place the worker reads settings (entry point
  passes `process.env`; app code never reads it):
  - `TEMPORAL_ADDRESS`: `host:port`, default `127.0.0.1:7233`. Only a loopback host
    (`127.0.0.1`, `localhost`, `::1`) is accepted: the compose stack binds Temporal to 127.0.0.1
    and the connection has no TLS.
  - `TEMPORAL_NAMESPACE`: default `default`; letters, digits, `.`, `_`, `-`, 1–64 characters.
  - `WORKER_APPLY_BROWSER`: `on` or `off`, default **off**. Only `on` starts the `apply-browser`
    pool, so nothing can be submitted until Paul turns it on (the `auto_apply` kill switch and the
    Gate still apply on every call).
  - `WORKER_CHROMIUM_PATH`: an absolute path to the installed Chromium, required when the browser
    pool is on (playwright-core downloads no browser, ADR-0028).
  - The pool limits (`loadPoolLimits`) and apply pacing (`loadApplyLimits`) as today.
  - A bad value names the setting and what it must be, never the value.
- `deferredFormDriver(hosts, launch)` (`packages/gateways`, `src/apply/browser/deferred.ts`): a
  `FormDriver` the gateway can take synchronously, which launches the browser on its first
  `open` with the adapter's own hosts. After `close()` it takes no further browser action: a close
  before `open` launches nothing, a close during the launch closes the new browser as soon as it
  starts and fails the step, and any step after close throws.
- The gateway's `openDriver` port takes the adapter's hosts (`openDriver(hosts)`), so the browser
  is bound to the ATS's hosts the gateway already checked the apply URL against.
- `workerActivities(db, settings)` (`src/wiring.ts`) binds the activities to the database:
  - `pipeline`: `recordSubmissionEnding`, and the sweep (`sweepStaleClaims` with `dbSweepPorts`,
    `recordSweepFailure`).
  - `apply-browser`: `submitApplication` with `dbPorts` (`readStoredFile` for files, the deferred
    driver for the browser, the configured pacing) and `readDecisionPackage` (NS-242).
- `main.ts` connects (`NativeConnection`) and runs one `Worker` per queue with `workerOptions`:
  `pipeline` with the workflows bundle (`src/workflows/index.ts`) and its activities, and
  `apply-browser` only when it is on. A failed connection or a bad setting exits non-zero with
  one line naming the problem. It shuts down cleanly on SIGINT/SIGTERM (Temporal's default).
- `pnpm --filter @northstar/worker start` builds and runs it, reading the root `.env.app` like the
  API. Placeholders for the new settings go in `.env.example`'s "Apps" part.

## Acceptance criteria
- [ ] `loadWorkerConfig` tests: defaults (browser off), loopback-only address, namespace shape,
      `on` needs an absolute Chromium path, errors name the setting and never the value.
- [ ] `deferredFormDriver` tests on a fake launcher: launches once on `open` with the hosts, close
      before open launches nothing, close during launch closes the browser and fails the step, no
      step after close.
- [ ] The gateway passes the adapter's hosts to `openDriver` (a test).
- [ ] `workerActivities` tests: the pools get exactly their activities; the browser pool's
      activities only when it is on.
- [ ] lint, typecheck, test and build green for `@northstar/worker` and `@northstar/gateways`.
- [ ] README's Getting started and Status, AGENTS.md, `.claude/rules/worker.md` updated.

## Out of scope (this slice)
- Starting workflows and sending signals (slice 2), worker health (slice 3), heartbeats (slice 4).
- Starting the sweep workflow on a schedule (the client helper's slice).
- A Temporal server in tests: none is started; `main.ts` is a thin shell over tested pieces.

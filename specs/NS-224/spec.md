# NS-224: The submission workflow survives a worker restart in Temporal's test environment

Issue: #229 (parent #108) · Requirements: RES-001, RES-005, RES-006 · ADRs: ADR-0001, ADR-0002,
ADR-0007, ADR-0016 · Builds on: NS-157 (`submissionWorkflow`), NS-225 (worker process, client
helper), NS-213 slice 2 (the relay's `isNotFound`, #195)

## Why
#108's "done when" asks that a submission workflow survive a worker restart without a second
submission. Every worker test so far runs without a Temporal server: `decide`, the activities on
fakes and the workflow bundler. The workflow's own branches (signals, durable waits, replay) and
the client's "no such workflow" handling have never run against a real server. The relay's
`isNotFound` matters most here, because the SDK marks the worker's own client experimental (#195's
leftover, moved here by #457).

Temporal's test environment downloads its server from `temporal.download`. Paul approved that host
and the dev dependency in the orchestrator's session (2026-11-28).

## What changes
1. **Dev dependency:** `@temporalio/testing@1.25.0` in `apps/worker`, the same version as the
   other `@temporalio/*` packages. The orchestrator adds it on Node 24 and commits the lock file.
2. **Tests** (`apps/worker/src/temporal.test.ts`), on `TestWorkflowEnvironment.createTimeSkipping()`,
   running the real workflow bundle. The activities are fakes registered under the real names
   (`submitApplication`, `recordSubmissionEnding`). The fake gateway keeps an in-memory claim ledger
   keyed per application and package, as the Apply Gateway's claim is. Its one submission is the
   counted side effect.
   - **Restart mid-wait:** start `submissionWorkflow` and signal `approval`. The first worker's
     gateway answers `InProgress`, so the run waits on a durable timer. Stop that worker and start
     a new one on the same queues. Time skips, the run replays from history and the gateway now
     submits. Checked: the result is `submitted` and the gateway submitted exactly once.
   - **Worker dies mid-activity:** the first attempt submits, then never answers until its worker
     shuts down (cancelled). The retry runs on a new worker, finds the claim and answers with the
     same submission, `replayed: true`. Checked: one submission, and the result is `submitted`
     with `replayed: true`.
   - **Not found on a real server:** `temporalPort` over the test client, and over the worker's own
     client (`Context.current().client` inside an activity, as `wiring.ts` binds it). For a
     workflow id that doesn't exist, `signal` answers `{ delivered: false }` and `waiting` answers
     `false`; nothing throws.
3. **Where they run:** the worker's normal `test` script, so CI runs them. CI runs only
   `turbo run lint typecheck test build`, and agents can't change `.github`. They get a 120 s
   per-test limit for the first download, never a skip. The server binary is cached in the OS temp
   directory by the SDK.
4. **Docs:** AGENTS.md (the worker's tests) and `.claude/rules/worker.md`.

## Security notes
- The test server is a binary the SDK downloads from `temporal.download` over TLS and caches in
  the OS temp directory. It isn't pinned by version or checked by hash, and `pnpm-lock.yaml`
  doesn't cover it. So it can change without a lock change, and a file already at the cache path
  is reused. In CI the build job holds no secrets and reads contents only. On Paul's machine it
  runs as his user. Pinning it (`testServer.executable` with a fixed version and download
  directory) is a follow-up if he wants it.
- The agent sandbox allows only the package registries, so these tests fail inside it. Locally
  they need Paul's shell, otherwise CI. Never widen the sandbox or turn it off to get them green.

## Out of scope
- The relay's `apply.signal_relay` dead-letter path on a real server: it needs the database in a
  worker activity, and its plain-code path is already tested.
- Running the real Apply Gateway or database in these tests.
- Any change to `.github` or a new turbo task.

## Decisions made without Paul
- **A dev dependency,** `@temporalio/testing@1.25.0`, approved by Paul through the orchestrator,
  which adds it.
- **In the default `test` run,** not a separate script: CI only runs `test`, and keeping the
  restart guarantee out of CI would leave it unchecked.

## Acceptance criteria
- [ ] Restart mid-wait: `submitted`, one submission.
- [ ] Worker dies mid-activity: `submitted` with `replayed: true`, one submission.
- [ ] Not found: both clients answer not delivered and not waiting, with no throw.
- [ ] CI's `build` job runs the tests, which proves it reaches `temporal.download`.

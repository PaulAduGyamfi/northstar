# NS-157: Temporal worker pools (slice 1: the submission workflow)

Status: draft (autonomous lane, ADR-0016)
Requirements: RES-001, RES-005
Rules that apply: ADR-0001, ADR-0002, ADR-0007, ADR-0016, `.claude/rules/worker.md`, `.claude/rules/gateways.md`

## Why
Nothing runs durably yet: the Apply Gateway is called directly. A submission has to wait for
Paul's approval (possibly for days), survive a crash, and retry without ever submitting twice.
Temporal (ADR-0001) gives durable waits, signals and retry policies for that.

## Behavior
- `apps/worker` (`@northstar/worker`) names the domain task queues (RES-001) and starts with
  `pipeline` and `apply-browser`.
- `submissionWorkflow` (runs on `pipeline`) waits for an `approval` signal carrying the Gate's
  decision id, or a `withdrawn` signal. No polling: a durable `condition`.
- It then runs the `submitApplication` activity on `apply-browser` with a 10-minute
  start-to-close timeout (the gateway's own step limits add up to 6.5 minutes, under its
  15-minute stale-claim limit) and a retry policy with backoff. Retrying is safe because the
  gateway claims each submission once by its idempotency key: a repeat finds the claim.
- The activity calls the gateway's `submitApplication` and returns a plain, serializable result.
  `NotApprovedError` becomes a non-retryable failure. A dated refusal (`Paced`,
  `DailyCapReached`, a breaker's `HeldBack`) becomes a wait in milliseconds, computed in the
  activity so the workflow never reads a clock.
- Plain code (`decide`) turns each activity result into: done (submitted or needs_human), wait
  then try again (`InProgress`, `AtsBusy`, `Paced`, `DailyCapReached`, `HeldBack`), or stop with
  the refusal (invalid package, host not allowed, posting mismatch, changed file, duplicate
  requisition). After 20 waits it stops as `gave_up` rather than loop forever.

## Acceptance criteria
- [ ] `decide` maps every `SubmitRefusal` kind and both outcomes as above (unit tests).
- [ ] The activity returns the gateway's outcome, turns `retryAt` into a wait, and throws a
      non-retryable `NotApproved` failure for `NotApprovedError` (unit tests with a fake gateway).
- [ ] The workflow code bundles with Temporal's workflow bundler (`bundleWorkflowCode`), which
      refuses Node built-ins and other non-deterministic imports.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- Gateway throws (database down, invariant error): the activity fails and Temporal retries it
  with backoff, at most 5 attempts; the claim makes a repeat safe.
- Approval never comes: the workflow waits durably at no cost.
- Kill switch or breaker holds: the workflow sleeps on a durable timer and tries again.

## Observability
The gateway's existing `apply.submit` span and events. Temporal history shows each step.

## Out of scope (follow-ups)
- The test that a submission survives a worker restart in Temporal's test environment: that
  environment downloads its server binary from `temporal.download`, which is network beyond the
  package registry (ADR-0016 item 5). Filed as a `needs:paul` issue.
- The worker process (`main`), its connection settings, worker health in `systemHealth`, the
  client that starts workflows, and the other domain queues: an `agent-filed` follow-up.
  There is no browser driver yet (NS-142), so the `apply-browser` worker can't run anyway.
- Activity heartbeats: the gateway has no step hook to heartbeat from yet.

## Open questions
None blocking.

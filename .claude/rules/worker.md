---
paths:
  - "apps/worker/**"
  - "packages/domain/**"
---

# Temporal workers and the domain (ADR-0001, ADR-0007)

`apps/worker` exists since NS-157: the `pipeline` and `apply-browser` queues (`src/queues.ts`),
`submissionWorkflow` and its plain `decide` step (`src/workflows/`), and the Apply Gateway
activity (`src/activities/apply.ts`). Workflow code may import only `@temporalio/workflow`, plain
code and type-only imports: the bundle test (`bundleWorkflowCode`) fails otherwise. No worker
process, client or heartbeats yet (NS-225); other domains' workflows arrive with their tickets.

Rules:

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

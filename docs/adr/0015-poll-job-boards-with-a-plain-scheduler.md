# ADR-0015 — Poll job boards with a plain scheduler for now; Temporal later

**Status:** Accepted · **Date:** 2026-11-25

## Context
NS-115 watches company job boards and adds new postings within each tier's freshness SLO
(SRC-003, SRC-012: 15 min tier 1, 30 min tier 2, 2 h long tail). ADR-0001 (Proposed) puts
business processes in Temporal workflows, and system-design §2 lists a `SourcingWorkflow` for
this. No Temporal code exists yet: adding it means new dependencies (`@temporalio/*`, with a
native core), a first worker app, and a test harness (`TestWorkflowEnvironment`) that downloads
a server binary, while AGENTS.md says no test may use the network. Polling itself needs none of
what Temporal is for: no human waits, no signals, no long-running steps.

## Decision
1. Polling is a plain function, `pollDue(deps, now)` in `packages/sources/src/poll.ts`: read the
   boards whose `next_poll_at` has passed, fetch each once, save new postings through the NS-114
   write path, and record the result.
2. All scheduling state lives in Postgres (`company_watch`: `next_poll_at`,
   `consecutive_failures`, `status`). Any process can run a pass; restarting loses nothing.
3. `jobs run` (a long-running CLI Paul starts) calls `pollDue` once a minute. `jobs poll` runs one
   pass.
4. Tier cadences are 10, 20 and 60 minutes. A failure doubles the board's interval, capped at
   6 hours; 5 consecutive failures quarantine it (RES-002, RES-003).
5. `pollDue` takes all its dependencies (fetch, clock, store) as arguments, so a Temporal activity
   can call it unchanged when workflows arrive.

## Alternatives considered
- **A Temporal `SourcingWorkflow` now:** the design's end state, but it adds the SDK and a worker
  app for a job that needs no durability beyond "remember the last poll", and its test harness
  needs the network.
- **The OS scheduler (cron, systemd timer) calling `jobs poll`:** works on Linux, but WSL often
  runs no cron or systemd, and Paul would set it up by hand per machine. `jobs run` is one command.

## Consequences
- + No new dependencies; every behavior is testable offline with an injected clock.
- + State in Postgres means `jobs run` can stop and start freely, and overdue boards catch up.
- − Polling only happens while `jobs run` is running (a sleeping laptop stops it). The SLOs hold
  only while it runs.
- − One more process Paul starts by hand until the worker fleet exists.
- We must keep: `pollDue` free of process-level state, so moving it into a Temporal activity is a
  wiring change, not a rewrite. The first ticket that needs signals (likely NS-119) adds Temporal
  and revisits this record.

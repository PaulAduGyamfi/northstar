# ADR-0001 — Orchestrate agents with durable workflows (Temporal)

**Status:** Proposed · **Date:** 2026-11-24

## Context
Nearly every feature is a long-running, multi-step process that pauses for a human (approve a package, approve a reply) or for time (follow up in 5 days, remind 1 h before interview). Steps call flaky externals (ATS sites, Gmail, Claude API). The user requires visibility into every step (S2) and no lost work.

## Decision
Use **Temporal** (TypeScript SDK). Each business process is a workflow; each agent/LLM call or side effect is an activity. Human approvals are **signals**; waits are durable **timers**. Workflow history doubles as the run inspector's source of truth.

## Alternatives considered
- **Queue + cron (BullMQ/pg-boss):** simpler to start, but approval waits, timers, retries and "resume after crash" become hand-rolled state machines across tables. That's the bug farm we'd be building.
- **Inngest / Trigger.dev:** good DX, durable steps and `waitForEvent`; viable if we want hosted-only and less ops. Temporal chosen for self-hostability, maturity and strong exactly-once semantics for side effects.
- **Agent frameworks owning the loop (LangGraph etc.):** solve the LLM loop, not durable business processes. We keep LLM loops *inside* activities.

## Consequences
- + Approvals that wait days cost nothing; deploys don't lose in-flight work; retries/backoff are declarative.
- + Built-in visibility (Temporal UI) during development.
- − Extra infrastructure (Temporal server) and workflow determinism rules developers must learn.
- Revisit if ops burden outweighs benefit for a single user → Inngest is the fallback.

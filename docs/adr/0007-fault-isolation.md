# ADR-0007 — Fault isolation: bulkheads, breakers, durable waits

**Status:** Accepted · **Date:** 2026-11-24

## Context
The system has many independent integrations (job sources, ATS adapters, Gmail, Calendar, GitHub, Claude API, headless browsers). The product owner requires that one faulty part never takes down the whole system.

## Decision
1. **Bulkheads:** one Temporal task queue + worker deployment per domain (`sourcing`, `pipeline`, `apply-browser`, `inbox`, `outreach`, `calendar`, `profile`, `growth`, `llm`). Browser workers run in their own containers with memory limits and are recycled after N sessions.
2. **Durable waiting instead of failing:** when a dependency is down, workflows wait (timers + retries) instead of erroring out. Temporal persists the state, so nothing is lost.
3. **Circuit breakers per dependency**, with state stored centrally and surfaced in the health model and UI.
4. **Plugin quarantine:** sources and adapters are plugins with a health score; consecutive failures quarantine them and route work to the assisted-apply fallback.
5. **Deterministic core:** policy checks, dedupe, idempotency and provenance validation are plain code with no LLM dependency, so safety holds even when AI is unavailable.
6. **Feature flags / kill switches** for every subsystem, controlled from the UI.
7. **Read path independence:** the web app reads from Postgres directly through the API; it never needs workers to render.

## Consequences
- + Failures are local, visible and recoverable; deploys of one pool don't affect others.
- − More deployables to operate. Mitigated by one compose file / one deploy manifest and the health page.

# ADR-0021 — LLM spend cap that pauses routes by priority

**Status:** Accepted (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

## Context
RES-009 asks for per-day caps on LLM spend, and that when a cap is hit "low-priority routes
(nightly re-scoring) pause first and fresh-job routes keep running" (freshness first, SRC-013).
`docs/cost-model.md` item 5 asks for daily and monthly caps. Today the gateway prices every call
(`callRecord().costUsd`, `pricing.ts`) but nothing stores spend, and routes have no priority.
`packages/llm` does not depend on `packages/db`, so the gateway can't read spend itself.

## Decision
- **Route priority.** `Route.priority?: "fresh" | "normal" | "low"`, default `normal`.
  - `fresh`: the routes on the path from a new posting to Paul's queue or a verification code:
    `job-extract`, `job-match`, `verification-extract`.
  - `low`: bulk work that can wait a day: `mail-classify` (the funnel backfill).
  - Every other route is `normal`.
- **Caps.** `LLM_DAILY_CAP_USD` and `LLM_MONTHLY_CAP_USD`, read once by `loadLlmBudget`
  (`packages/llm`, the one typed config for it); each is optional, and unset means no cap. A day
  and a month are UTC.
- **Thresholds.** Against each cap, a route is held back when spend so far reaches:
  - 80 % for `low`,
  - 100 % for `normal`,
  - 125 % for `fresh`: a hard ceiling, so fresh-job routes keep running past the cap but can
    never spend without limit.
- **Where it's checked.** `createLlmGateway` takes an optional `budget: { caps, meter }`. Before
  the kill switch and breaker, it asks `meter.spent()` and, over the threshold, throws the
  existing retryable `HeldBack` with `by: "budget"`. After a reply it calls
  `meter.record(route, costUsd)`. A meter that fails holds the call back (fail safe), and a
  failed record is kept in memory and written before the next call, which is held back until it
  is, so failing writes can't switch the cap off. An unpriced model (a fallback the API chose, a
  new id) is metered at the dearest known model's prices (`ceilingCostUsd`) and sets
  `northstar.llm.unpriced` on the span: it can over-count, never pass unmetered.
- **Storage.** `llm_spend` in `packages/db` (`spend-write.ts`), append-only: candidate, route,
  cost in micro-dollars, time. `readLlmSpend` sums today's and this month's. No domain event per
  call (the `llm.call` span already carries the cost); the hold is visible on the span and in the
  CLIs' held-back message.
- **Wiring.** The funnel, profile and sources CLIs and the API pass a meter on the stored spend.
  Evals pass none: replay costs nothing, and `--live` / `--record` (Paul only, on purpose) are
  deliberately not capped. With no cap set the gateway reads no spend and holds nothing back, but
  still records each reply's cost.

## Alternatives considered
- One cap that stops every route: breaks freshness first (RES-009, SRC-013).
- Fresh routes with no ceiling: a runaway poll could spend without bound.
- Summing spend from domain events: not every call writes an event, and payloads aren't typed
  for it.
- Budget in the breaker: a breaker is about a dependency failing, not about money.

## Consequences
- A new route must choose its priority deliberately (default `normal`).
- Spend is metered only where a meter is wired; a new entry point must pass one.
- The 80 / 100 / 125 % split is a starting point: Paul may move it once real spend is metered
  (NFR-CST-001, OBV-003).
- Spend is read before a call and recorded after it, so calls running at the same time can each
  pass just under a threshold: the overshoot is at most one call's cost per concurrent call,
  small with today's one-at-a-time CLIs and captures.
- Open question: a separate monthly ceiling per priority, if a month runs hot.

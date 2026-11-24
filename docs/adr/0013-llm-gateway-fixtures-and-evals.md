# ADR-0013 — LLM gateway contract, request-keyed fixtures and replay evals

**Status:** Proposed · **Date:** 2026-11-24

## Context
ADR-0006 puts every model call behind `packages/llm`. NS-106 builds that gateway and the eval
harness. Four choices in it will last. They are: what a call returns, how tests avoid the
network, how evals run in CI, and where cost numbers come from. They serve OBV-003 (per-call
observability), NFR-AIQ-001 (an eval set per LLM feature) and NFR-AIQ-003 (versions on every
output). Two constraints force the choices: no test may call a real model (AGENTS.md), and CI
holds no secrets (ADR-0011).

## Decision
1. **Values for model outcomes, exceptions for transport.** `gateway.call(route, input)` returns
   `Ok | Refused | Truncated | InvalidOutput`, each with a `CallRecord`. Timeouts, 429, 5xx and
   connection failures throw `LlmTransportError { retryable }`, so a Temporal activity retries
   them and never retries a refusal.
2. **One request shape.** Adaptive thinking, an explicit `effort` per route, structured output
   from the route's Zod schema (validated again on arrival), server-side refusal fallback
   (`fallbacks: "default"`), stable system blocks first with one cache breakpoint on the last
   stable block, and only volatile text in the user turn. The gateway takes no tools.
3. **No text in telemetry.** The `llm.call` span and the call record carry ids, versions,
   tokens, cost and outcome only. The SDK's OpenTelemetry content mode is pinned to
   `metadata_only` in code, so an environment variable can't turn on prompt export.
4. **Fixtures keyed by the request.** A fixture file is named by the SHA-256 of the canonical
   request JSON. Replay never matches "close enough": any change to prompt, model, effort or
   schema is a `MissingFixture` until someone re-records on purpose.
5. **Evals replay in CI, run live by hand.** `pnpm --filter evals eval <route>` replays recorded
   responses by default and fails below `baseline.json`. `--live` and `--record` call the API
   and are run by Paul on prompt or model changes. The new baseline and the output go in the PR.
6. **Prices in code.** `packages/llm/src/pricing.ts` holds USD per million tokens with the
   source and date. An unknown model costs `null`, not a guess.

## Alternatives considered
- **Throw on refusal or invalid output:** the caller couldn't tell "retry later" from "a retry
  will refuse again", and Temporal would retry and pay for a refusal.
- **Fixtures matched by route and case id only:** a prompt edit would keep replaying the old
  answer, so CI would pass a change that was never tested.
- **API key in CI for live evals:** a secret in CI and real spend on every PR. CI stays
  secret-free (ADR-0011).
- **Mocking the SDK per test:** each test would invent its own response shape. One fake client
  and shared synthetic responses keep the shape in one place.
- **Prices from the API at runtime:** there is no pricing endpoint. Usage reports give totals
  later, not per call.

## Consequences
- + Every route gets caching, refusal handling, metering and version stamps without its own
  code.
- + Tests and CI evals are free, deterministic and offline.
- − Replay evals prove parsing, graders and recordings, not model quality. Quality is only as
  current as the last live run, so a prompt or model change must come with a live run and a new
  baseline.
- − Recording costs money and needs Paul. Recorded fixtures go to public git, so they may hold
  only synthetic inputs. Real-mail cases stay in `evals/**/private/` (gitignored).
- − The price table goes stale when prices change, and must be updated by hand.
- Dependencies, approved by Paul for NS-106:
  - Runtime, in `packages/llm`: `@anthropic-ai/sdk@1.7.0` and `@opentelemetry/api@1.9.1`
    (already used by `packages/db`).
  - Dev: `@opentelemetry/sdk-trace-base@2.12.1`.
  - Vitest brings its own `@opentelemetry/api@1.10.0`. Two copies are harmless: the global
    tracer is shared per major version.
- Open question: whether server-side fallback should stay on for routes where a fallback
  model's answer would be worse than a `needs_human`.

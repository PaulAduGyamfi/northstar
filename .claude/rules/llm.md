---
paths:
  - "packages/llm/**"
  - "packages/prompts/**"
  - "packages/agents/**"
  - "evals/**"
---

# LLM gateway, prompts, agents and evals (ADR-0004, ADR-0006)

None of these exist yet. If you are about to create one outside its ticket, stop and ask Paul.

When they land:

- Only `packages/llm` imports `@anthropic-ai/sdk`. Agents call the gateway, never the SDK.
- Default model `claude-opus-5-5` with adaptive thinking and an explicit `effort` per route.
  A cheaper tier needs an eval result and an amendment to ADR-0006.
- Every agent result is a structured output validated with its Zod schema on arrival. Check
  `stop_reason` (including `refusal`) before reading content.
- Prompts are versioned files (`<route>.v3.md`), never edited in place. Stamp prompt version and
  model on every output.
- Stable prefix first for caching: system prompt, then profile-graph summary, then voice guide,
  then the volatile job or email.
- Untrusted text (JDs, emails, web pages) goes in clearly delimited data blocks, and agents that
  read it get no side-effect tools.
- Generated claims cite atom or story IDs; the provenance validator is plain code and runs after
  every generation.
- Meter tokens, cache hits, cost and latency per call (OBV-003). Respect the budget caps (RES-009).
- Tests use recorded fixtures, never a real model. Evals are the only place real model calls run,
  and only on purpose (they cost money).

# ADR-0006 — LLM strategy (Claude API behind an LLM Gateway)

**Status:** Proposed · **Date:** 2026-11-24

## Decision
- All model calls go through `packages/llm` (LLM Gateway) over the official **Anthropic TypeScript SDK** (`@anthropic-ai/sdk`).
- **Default model: `claude-opus-5-5`** with adaptive thinking and an explicit `effort` per route (Opus 5.5 defaults to `medium`; set it deliberately: `low` for classification/extraction, `high` for answers/tailoring).
- Cheaper tiers (`claude-sonnet-5-5`, `claude-haiku-5-5`) only for high-volume routes (email pre-classification, job extraction, dedupe confirmation) **after** an eval shows equal quality — recorded as an amendment here. Measure "Opus at low effort" first; one model keeps one prompt cache.
- **Structured outputs** (`output_config.format`) for every agent result; Zod schemas shared with the app.
- **Prompt caching** on stable prefixes: system prompt → profile graph summary → voice guide → (volatile) job/email.
- **Message Batches** for nightly re-scoring and bulk jobs (50% cost).
- Handle `stop_reason: "refusal"` explicitly; enable server-side fallbacks.
- LLM loops (tool use) live *inside* Temporal activities; the Messages API tool runner is sufficient. Anthropic **Managed Agents** may be evaluated later for open-ended research tasks (company research, prep briefs) — not for anything that touches gateways.
- Every route: versioned prompt file, eval set (`evals/<route>`), cost + token metering per call, prompt/model version stamped on outputs.

## Consequences
- + Swappable models per route without touching business logic; costs visible per feature.
- − Gateway is one more package to maintain; it's thin.

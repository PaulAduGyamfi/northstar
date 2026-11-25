---
paths:
  - "packages/llm/**"
  - "packages/prompts/**"
  - "packages/agents/**"
  - "evals/**"
---

# LLM gateway, prompts, agents and evals (ADR-0004, ADR-0006)

`packages/llm` and `evals/` exist since NS-106 (ADR-0013); `packages/prompts` and the first
route (`profile-extract` in `packages/profile`) since NS-110, `story-draft` since NS-111.
`packages/agents` doesn't exist yet. Ask Paul before creating it.

- Load prompts with `loadPrompt(id, version)`. A new or changed prompt is a new file
  (`prompts/<route>/vN+1.md`) plus `pnpm --filter @northstar/prompts lock`; the lock test fails
  if a committed version changes.
- Register every route's eval set in `evals/src/routes.ts`; CI replays them all.
- Never run `profile import-resume`, `profile show`, `profile interview` or `profile stories`
  yourself: they read and print Paul's real resume, profile, answers and stories. Test with the
  synthetic fixtures; Paul runs the real commands.
- The `mail-classify` route (NS-113) lives in `packages/inbox`. Never run any `funnel` command
  yourself: they read Paul's real Gmail and print his real applications.

- Call the model only through `createLlmGateway(...).call(route, input)`. Handle every
  `LlmOutcome` kind (`Ok`, `Refused`, `Truncated`, `InvalidOutput`). Let `LlmTransportError`
  throw so Temporal retries it. Put the `CallRecord` in the domain event.
- Wrap untrusted text with `untrustedBlock(kind, text)` in the route's volatile part.
- Only `packages/llm` imports `@anthropic-ai/sdk`. Agents call the gateway, never the SDK.
- Default model `claude-opus-5-5` with adaptive thinking and an explicit `effort` per route.
  A cheaper tier needs an eval result and an amendment to ADR-0006.
- Every agent result is a structured output validated with its Zod schema on arrival. Check
  `stop_reason` (including `refusal`) before reading content.
- Prompts are versioned files (`prompts/<route>/vN.md`), never edited in place once committed. Stamp prompt version and
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
- A prompt or model change needs Paul's `eval <route> --live` run. Commit the new
  `baseline.json`, re-record the fixtures with `--record`, and paste the output in the PR. CI only
  replays.
- Recorded fixtures are public. Record only synthetic inputs, and keep real-mail cases in
  `evals/**/private/`. The eval CLI has no private mode yet: it reads only
  `<route>/cases.jsonl` and writes fixtures to the public `<route>/fixtures/`. Never put a
  real-mail case there or run `--record` on one.

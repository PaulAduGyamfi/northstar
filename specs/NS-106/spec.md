# NS-106: LLM gateway + eval harness (structured outputs, caching, metering, recorded fixtures)

Status: approved by Paul (2026-11-24; replay-only evals in CI, prompts on the route, fallbacks on, skill price table, one PR)
Requirements: ADR-0006 (LLM strategy), NFR-AIQ-001 (eval set per LLM feature), NFR-AIQ-003
(prompt and model version on every output), OBV-003 (per-call LLM observability), RES-005
(timeouts and retries), NFR-SEC-004 (untrusted text is data). GitHub issue #7.
Rules that apply: AGENTS.md (code style, tests never call a real model, dependencies),
`.claude/rules/llm.md`, `.claude/rules/tests.md`, ADR-0013 (written this ticket).

## Why
Every agent ticket after this one (profile import, fit scoring, tailoring, answers, inbox) calls
Claude. If each one calls the SDK its own way, cost, caching, refusals and prompt versions drift
and nobody can see what a feature costs or whether a prompt change made it worse. After this
ticket there is one narrow door to the model: typed in, typed out, versioned, metered, cached,
safe on refusal, and testable without the network. And there is one way to score a route before
and after a change.

## Behavior
**`packages/llm`** (the only package that imports `@anthropic-ai/sdk`):
- A **route** is a typed definition: name, prompt (`id`, `version`, text), model (default
  `claude-opus-5-5`), required `effort`, `maxTokens`, `timeoutMs`, a Zod output schema, and a
  `render(input)` that returns the stable context blocks and the volatile request text.
- `createLlmGateway({ client, clock })` returns `call(route, input)`. Each call:
  - sends adaptive thinking, the route's `effort`, a structured-output JSON schema made from the
    Zod schema, and the server-side refusal fallback (`fallbacks: "default"`, beta
    `server-side-fallback-2026-07-01`, which ADR-0006 asks for);
  - orders the system prompt stable-first (prompt text, then each stable context block) with
    the cache breakpoint on the last stable block, and puts only the volatile text in the user
    turn (llm.md caching order);
  - checks `stop_reason` before reading content: `refusal` returns a `Refused` value with the
    category, `max_tokens` returns `Truncated`, otherwise the JSON is validated with the Zod
    schema and a mismatch returns `InvalidOutput` (field paths only, never values);
  - stamps every result, success or not, with a **call record**: route, prompt id and version,
    requested and served model, effort, input, output, cache-read and cache-write tokens,
    latency, cost in USD, stop reason, refusal category, whether a fallback model served it
    (NFR-AIQ-003, OBV-003);
  - opens the span `llm.call` with the same fields as attributes. The SDK's own span nests under
    it. Prompt and response text never go into spans or logs: the SDK's content mode is pinned
    to `metadata_only` in code, so an environment variable can't switch it on.
- Transport failures (timeout, 429, 5xx, connection) are thrown as `LlmTransportError` with a
  `retryable` flag, so a Temporal activity can retry them. Expected model outcomes (refusal,
  truncation, invalid output) are returned as values, never thrown.
- `untrustedBlock(kind, text)` wraps job pages, emails and web text in a delimited data block
  that says it is data, not instructions, and neutralizes a closing tag inside the text
  (NFR-SEC-004). The gateway takes no tools, so no route can get a side-effect tool.
- `costUsd(model, usage)` comes from a price table in code (USD per million tokens, with its
  source and date). An unknown model gives `null` and a flag on the record, never a guess.
- `loadLlmConfig(env)` reads `ANTHROPIC_API_KEY` (Zod-checked, never echoed). Only entry points
  pass `process.env`.

**Recorded fixtures** (`packages/llm`):
- `createReplayClient(dir)`: answers a request from a fixture file named by the SHA-256 of the
  request's canonical JSON. A missing fixture throws `MissingFixture` naming the route and key.
  Any prompt or parameter change changes the key, so a stale recording can't pass silently.
- `createRecordingClient(realClient, dir)`: calls the real API and writes the fixture. Used only
  by `eval --record`, on purpose, by Paul.

**`evals/`** (workspace package `evals`, NFR-AIQ-001):
- An eval set is `evals/<route>/cases.jsonl` (id, input, expected) plus `baseline.json` (pass
  count, total, model, prompt version, date).
- Graders are plain functions (`exactField`, `schemaOnly`, `fieldsSubset`); an LLM-as-judge
  grader is out of scope.
- `pnpm --filter evals eval <route>` runs every case through the gateway and prints one line per
  case plus a summary (passed/total, tokens, cost). It exits non-zero if the pass count is below
  the baseline.
  - Default mode is **replay**: recorded fixtures, no network, no key. This is what CI runs.
  - `--live` calls the real API. `--record` calls it and saves fixtures. Both need the key and
    are only run by Paul, because they cost money.
- No production route exists yet, so the CLI's route registry is empty. The harness is proven
  with a test-only route and synthetic fixtures. The first agent ticket adds the first real
  route, its prompt file and its eval set.

## Acceptance criteria
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, with tests in `packages/llm`
      and `evals`.
- [ ] Gateway tests (fake client, synthetic responses) prove:
  - the request has the route's model, effort, adaptive thinking, JSON schema, fallback
    setting, stable-first system blocks with exactly one cache breakpoint on the last one, and
    only the volatile text in the user turn;
  - a valid response returns the parsed output and a call record with exact token, cache and
    cost numbers;
  - `refusal` returns `Refused` with the category and never reads content;
  - `max_tokens` returns `Truncated`;
  - JSON that fails the schema returns `InvalidOutput` with field paths and no values;
  - a fallback-served response records the served model and `fallbackUsed: true`;
  - a 429 or 5xx is thrown as a retryable `LlmTransportError`; a 400 as non-retryable;
  - the span `llm.call` carries the call-record attributes and no prompt or response text;
  - an unknown model gives `costUsd: null`.
- [ ] `untrustedBlock` tests: the text is wrapped, and a closing tag inside it can't end the block.
- [ ] Replay tests: the same request replays the same response; a changed prompt is a
      `MissingFixture`; record then replay round-trips.
- [ ] Eval harness tests (test route, synthetic fixtures): a run reports exact pass counts; a
      score below the baseline exits non-zero; equal or above exits 0; replay mode makes no
      network call.
- [ ] `grep -rl "@anthropic-ai/sdk" --include=*.ts apps packages evals` lists only
      `packages/llm` files.
- [ ] `.env.example` has `ANTHROPIC_API_KEY=` with a placeholder. AGENTS.md lists the eval
      commands.
- [ ] `checks` is green on the PR.

## Failure modes
- **Claude API slow:** each route has a timeout (RES-005), and the SDK retries 408/409/429/5xx
  twice with backoff. After that an `LlmTransportError` reaches the caller (a Temporal activity
  later), which retries durably or ends in `needs_human`. Never a silent drop.
- **Claude API down or rate-limited:** same path, `retryable: true`. A circuit breaker (RES-002)
  and budget caps (RES-009) are NS-126.
- **Refusal:** server-side fallback first. If the whole chain refuses, the caller gets `Refused`
  with the category and decides (needs_human with a plain-English reason).
- **Garbage output:** structured outputs make malformed JSON unlikely. Zod still checks every
  result, and a mismatch is `InvalidOutput`, never a partial object.
- **Output cut off:** `Truncated`, with the call record, so the route's `maxTokens` can be
  raised on evidence.
- **Missing API key:** `loadLlmConfig` fails at startup and names the setting. Replay mode needs
  no key.
- **Stale fixture:** a request change becomes `MissingFixture` naming route and key. Re-record
  on purpose.
- **Prices change:** the table is wrong until updated. Its date sits next to it, and
  cost-model.md already says real spend gets recalibrated.

## Observability
- Span `llm.call`: `northstar.llm.route`, `.prompt_id`, `.prompt_version`, `.model.requested`,
  `.model.served`, `.effort`, `.tokens.input`, `.tokens.output`, `.tokens.cache_read`,
  `.tokens.cache_write`, `.latency_ms`, `.cost_usd`, `.stop_reason`, `.refusal_category`,
  `.fallback_used`, `.outcome`. The SDK's metadata-only span nests under it.
- The call record is returned to the caller, which writes it into its domain event (NS-105).
  Storing call records for the run inspector and per-route views is NS-125.

## Out of scope
- Any production route, prompt file, agent or `packages/prompts` (each arrives with the first
  ticket that needs it).
- Budget caps, circuit breakers and bulkheads (NS-126). Message Batches. Embeddings.
- Tool use and tool loops. LLM-as-judge graders. Running live evals in CI.
- Persisting call records (NS-125). OpenTelemetry SDK setup and exporters (the app tickets).

## Open questions
1. **Evals in CI (NFR-AIQ-001 says "run in CI").** CI has no secrets by design, so it can't
   call the model. Recommended: CI runs evals in replay mode, which proves the graders, parsing
   and recordings. Live runs (`--live`) are Paul's, on prompt or model changes, with the result
   committed in `baseline.json` and pasted in the PR. The alternative, an API key secret in CI,
   is an ADR-0011 change.
2. **Where prompts live before `packages/prompts` exists.** Recommended: the route carries its
   prompt text, id and version; the prompt registry and an immutability check (a hash manifest
   that fails CI if a versioned prompt file changes) arrive with `packages/prompts` in the first
   agent ticket.
3. **Server-side fallback by default.** The API skill recommends `fallbacks: "default"` on
   Opus 5.5, and ADR-0006 says "enable server-side fallbacks". A fallback model may serve a
   call; the record shows it. Inferred: the fallback model's price is looked up from the served
   model on the response.
4. **Price table source.** The Anthropic API skill's model table (cached 2026-11-03): Opus 5.5
   $4 in, $20 out, $0.20 cache read per million tokens. Cache write is assumed to be 1.25 times
   the input price (5-minute TTL). Inferred, not read from the live pricing page.
5. **Diff size.** About 550 lines of source and 500 of tests, over AGENTS.md's ~300.

# ADR-0033 — OpenAI embeddings for job dedupe, as suggestions only

**Status:** Proposed · **Date:** 2026-11-28

## Context
SRC-006 asks that the same role posted on several sources collapse into one job, matching on
company, title, place and a description embedding. NS-114 built the deterministic part in
`findDuplicate` (`packages/sources/src/dedupe.ts`): the same ATS posting id, the same canonical
URL, or the same company and title with descriptions at least 85% alike by three-word shingles.
A role reworded on a second board slips past the shingle rule and shows up twice in the queue.

Anthropic offers no embeddings API, and ADR-0006 sends every model call through `packages/llm`
over the Anthropic SDK. Paul chose OpenAI as the embeddings provider (Q-19) and approved building
it on 2026-11-28 (#52). Embeddings need a vector store; pgvector has been installed since the first
migration (`0000_extensions.sql`) and runs in the PGlite tests.

## Decision
1. **Provider and model.** OpenAI's embeddings endpoint, `POST https://api.openai.com/v1/embeddings`,
   model `text-embedding-3-small` with `dimensions: 512`. The model name and dimensions are
   constants in one place (`packages/llm/src/embed/`), stored with every vector, so a later change
   re-embeds instead of mixing vectors. Price at the time of writing: about $0.02 per million input
   tokens (open question: check OpenAI's price list before turning it on). A job's text is a few
   hundred tokens, so a month of jobs costs cents.
2. **What is sent.** Only `embeddingText(job)` (`packages/sources`): the job's title, company and
   requirements lines, all from the employer's own posting. Never Paul's profile, resume, atoms,
   stories, answers, contact details, emails, preferences or anything else of his, and never a URL.
   A test pins the exact fields.
3. **No SDK.** Plain `fetch`, no new dependency. The client refuses any host but `api.openai.com`,
   follows no redirect and gives up after 20 s (RES-005). The key is `OPENAI_API_KEY`, kept only
   in `.env.app`, read through one typed loader (`loadEmbedConfig`), with a placeholder in
   `.env.example`. It is never logged, put in a span or an error, or sent anywhere else.
4. **Off by default.** `JOB_EMBEDDINGS=on` turns it on; anything else, or no key, sends nothing.
   `on` without a key, or with the placeholder, refuses to start and names the setting.
5. **Guarded like a model route.** Every call runs behind the `agent:job-embed` kill switch, the
   `openai` breaker (ADR-0007: only no answer, a cut-off body, 408, 409, 429 and 5xx count; a 400 or 401 means it answered)
   and the shared LLM spend cap (ADR-0021: route `job-embed`, priority `low`, its cost recorded in
   `llm_spend`). A held-back call never goes out.
6. **Suggestions only.** An embedding match never merges, edits or deletes a job. `findDuplicate`
   stays the only thing that merges. A pair of jobs it kept apart that is at least the threshold
   alike becomes a stored suggestion with a fixed-word feed line, for Paul to check (later slices,
   with their own migration). The threshold is set from a labelled synthetic set, measured
   against the shingle rule, before anything is turned on.
7. **This amends ADR-0006's "Claude only" rule for this one use:** embeddings, not chat, and no
   text from Paul. Any other non-Anthropic model call still needs its own ADR.

## Alternatives considered
- **Voyage AI** (the provider Anthropic suggests): a fine choice; Paul picked OpenAI.
- **A local open-source model**: no vendor or key, but a heavy runtime and model file in the repo's
  dependencies and CPU time on every pass; Paul picked a hosted API.
- **The official `openai` SDK**: a large dependency for one HTTP call; plain `fetch` keeps the
  request shape visible and testable.
- **No embeddings** (shingles only): keeps SRC-006 partly unmet for reworded postings.

## Consequences
- + Reworded duplicates can be caught, and Paul sees each suggestion instead of a silent merge.
- + Spend, kill switch and breaker work as for every model route; `/health` shows it.
- − A second model vendor holds a key and sees job postings' text (public text, but still a
  vendor relationship Paul manages).
- − Vectors must be re-made if the model or dimensions change; they are stamped with both.
- We must keep `embeddingText` to employer text only: any new field needs this ADR amended.

# NS-129: Embedding-based job dedupe (suggestions only)

Status: slice 1 merged (#462); slice 2 in progress (autonomous lane, ADR-0016; Paul approved building it on 2026-11-28)
Issue: #52 (split out of NS-114, #13). Provider: OpenAI (Q-19, decided by Paul 2026-11-28).
Requirements: SRC-006 (description embedding), RES-002, RES-005, RES-008, RES-009, OBS-001
Rules that apply: ADR-0002, ADR-0005, ADR-0007, ADR-0008, ADR-0016, ADR-0021, ADR-0033 (this
ticket, OpenAI embeddings), `.claude/rules/db.md`

## Why
SRC-006 asks that the same role posted on two sources collapse into one job, matching on
company, title, place and a description embedding. NS-114 built the deterministic part: the same
ATS posting id, the same canonical URL, or the same company and title with descriptions at least
85% alike by word shingles. A role reworded on a second board (a recruiter's copy, an aggregator)
slips past the shingle rule and shows up twice in the queue.

## Behavior
Embeddings only **propose**. The deterministic dedupe in `findDuplicate` stays the one thing that
merges jobs; an embedding match never merges, edits or deletes a job by itself.

Built in slices, each its own PR:

1. **The decision and the client (this PR).**
   - ADR-0033: OpenAI embeddings for job dedupe. Model `text-embedding-3-small` at 512 dimensions
     (the API's `dimensions` parameter), its price, what is sent (only a job's title, company and
     requirements lines, all from the employer's own posting), what is never sent (Paul's
     profile, resume, stories, answers, emails or anything else of his), the threat model, and an
     amendment note on ADR-0005/0008's "Claude only" stack rule for this one non-chat use.
   - `packages/llm/src/embed/`: `embedText(texts)` through plain `fetch` to
     `https://api.openai.com/v1/embeddings` (no SDK, no new dependency). It refuses any other
     host, sends no redirects, has a 20 s limit, and runs behind the `agent:job-embed` kill switch,
     the `openai` breaker (only no answer, a cut-off body, 408, 409, 429 and 5xx count) and the LLM spend cap (route
     `job-embed`, priority `low`; its cost is recorded in `llm_spend` like a model reply). Its span
     holds the model, the input count, token usage and the status, never the text.
   - `loadEmbedConfig`: `JOB_EMBEDDINGS` (`on` / `off`, default off) and `OPENAI_API_KEY` (in
     `.env.app` only; a placeholder in `.env.example`). `on` without a key, or a placeholder key,
     is refused by name. Off, nothing is ever sent.
   - `embeddingText(job)` (`packages/sources`): the exact text sent for a job, plain code.
2. **Storage and suggestions.** A migration adds append-only `job_embedding` (one per job, model
   and text SHA-256, a `vector(512)`) and `job_duplicate_suggestion` (a pair of the candidate's
   own ready jobs, the cosine similarity, the model; one per pair). `suggestDuplicates` stores a
   suggestion when two jobs the deterministic rule kept apart are at least the threshold alike,
   with a `job.duplicate_suggested` event and a fixed-word feed line ("Two saved jobs look like
   the same role: check them").
3. **Wiring and measurement.** `jobs score` / the poll pass embed new ready jobs and suggest
   duplicates while `JOB_EMBEDDINGS=on`; `jobs dupes` lists suggestions with both jobs' titles for
   Paul. The threshold is set from a labelled synthetic set, measured against the shingle rule,
   before anything is turned on.

## Acceptance criteria
- [x] Slice 1: ADR-0033 written (Proposed); the client sends exactly one request shape to exactly
      one host, refuses a redirect, and sends nothing while the switch is off, the breaker is
      open, the spend cap holds `low` back or `JOB_EMBEDDINGS` is off (tests with a fake `fetch`;
      no test calls the network).
- [x] Slice 1: only no answer, a cut-off body, 408, 409, 429 and 5xx count against the breaker; a 400 or 401 doesn't.
- [x] Slice 1: the cost of each call is recorded through the spend meter.
- [x] Slice 1: `embeddingText` holds the title, company and requirements only (a test).
- [ ] Slice 2: append-only `job_embedding` and `job_duplicate_suggestion` (triggers, CHECKs,
      same-candidate foreign keys; the app role's grants), a vector stored whenever a job's text
      differs from its newest (a text it held before included), so the newest is current; never
      a zero vector.
- [ ] Slice 2: `findSimilarJobs` compares only each other ready, open job's newest vector, and
      never another candidate's.
- [ ] Slice 2: a pair is suggested once whichever way round, with one fixed-word
      `job.duplicate_suggested` event; `suggestDuplicates` stores at most 5 per job and never
      changes a job.
- [ ] AGENTS.md, README and `.env.example` describe each slice.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Failure modes
- OpenAI slow or down: 20 s limit, the `openai` breaker, and the job keeps its deterministic
  dedupe; no suggestion is lost for good, the next pass embeds again.
- Key missing, wrong or revoked: `on` without a key refuses to start; a 401 is reported on the
  span and not counted against the breaker (it answered).
- Spend cap reached: held back like any `low` model route.
- Wrong suggestion: nothing is merged; Paul dismisses it (slice 3).

## Observability
- Span `llm.embed` (model, input count, tokens, status; never text or the key).
- `job.duplicate_suggested` events (slice 2), ids and the similarity only. The event's aggregate
  is the lower job id, so the feed names that job; `jobs dupes` (slice 3) reads both jobs from
  `job_duplicate_suggestion`, not from the event.

## Out of scope
- Merging jobs from a suggestion (Paul merges by hand, or a later ticket).
- Embeddings for questions, atoms or stories (system-design §4 plans them; not this ticket).

## Decisions made without Paul
- The model and dimensions (`text-embedding-3-small` at 512), the threshold method, and the
  `low` priority under the shared spend cap.
- A schema change in slice 2 (two new append-only tables).

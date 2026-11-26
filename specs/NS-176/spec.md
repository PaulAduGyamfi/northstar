# NS-176: Backpressure, quotas, LLM spend cap and timeouts on every external call

Status: accepted (autonomous lane, ADR-0016), in slices
Requirements: RES-005, RES-009 · ADR-0007
Rules that apply: `.claude/rules/llm.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #87 (NS-147)

## Why
RES-005: every external call has a timeout; no unbounded waits. RES-009: bounded concurrency per
pool, daily caps, and an LLM spend cap that pauses low-priority routes first while fresh-job routes
keep running (SRC-013).

## Slices
The three parts share little, and together pass the size guideline (ADR-0016):
1. **Timeouts (this PR)**: close the gaps below.
2. **LLM spend cap**: spend recorded per call, daily and monthly caps from one typed config, a
   route priority, and a `budget` hold in the LLM guard that pauses low-priority routes first. It
   needs an ADR (the cap's design is a lasting decision) and a table. Its own spec section lands
   with it.
3. **Bounded concurrency per pool**: needs the worker (NS-157, blocked); a follow-up issue.

## Slice 1: timeouts on every external call (RES-005)
Already bounded (no change): `safeFetch` (15 s for all hops and the body), Gmail reads and the
OAuth token exchange (30 s), each LLM route (`timeoutMs` per attempt, 2 retries), the Apply
Gateway's driver steps (60 s open, 5 min submit, 30 s close), the web server's calls to the API
(3 s).

Gaps closed:
1. **DNS** (`packages/sources/src/fetch.ts`): the lookup on every hop runs before the fetch's
   signal and had no limit. It now gives up after 5 s (`FetchRefused`: the host can't be found).
2. **The Anthropic client** (`packages/llm`): a default `timeout` of 180 s, the slowest route's,
   so a call made without a route timeout can't wait forever.
3. **Postgres** (`packages/db` `connectDb`, the CLIs and the API): a 10 s connect timeout and a
   60 s statement timeout (migrations use their own pool and are unaffected).
4. **The extension's capture request** (`apps/extension`): 5 min, the server's worst case
   (fetch, extraction with retries, scoring).
5. **The web app's browser calls to its own API** (`apps/web`): through one helper with a 15 s
   timeout, and a plain message when it gives up.

### Acceptance criteria (slice 1)
- [ ] A DNS lookup that never answers is refused after 5 s (fake timers).
- [ ] The SDK client options carry the default timeout; the Postgres pool carries its limits.
- [ ] The extension's and the web app's requests carry an abort signal with their limit.

## Out of scope
Slices 2 and 3 (above).

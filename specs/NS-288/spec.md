# NS-288: Refuse YC's own site and Work at a Startup as job sources

Issue #477 · Parent #460 (NS-282 slice 3) · Requirements: SRC-001, SRC-003 · ADR-0003

## Problem
NS-282 slice 3 may read YC's job listings only if YC's terms allow automated reads. The agents'
environment can't reach `www.ycombinator.com` or `www.workatastartup.com` to read them, and Work at a
Startup needs a sign-in to see jobs. Until the terms are read, Northstar must not fetch either site.

## Decision
Recorded on #477 under Paul's delegation: option 3, "won't read" for now. Easy to revisit: once the
terms are read and quoted on #477, a follow-up can change the status and build a reader.

## Plan
1. `terms.ts`: every `ycombinator.com` host except `news.ycombinator.com`, and every
   `workatastartup.com` host, are `prohibited`. `news.` stays readable because the HN "Who is
   hiring?" thread's postings link there (NS-282 slice 1).
2. `termsFor` drops a trailing dot before matching (`www.linkedin.com.` is the same host), which
   closes the same gap for every prohibited site.
3. Docs: AGENTS.md, `.claude/rules/gateways.md`, NS-282's spec (slice 3 outcome).

## Acceptance criteria
- [x] `jobs add` refuses a YC or Work at a Startup link with no network call, and its reason points
      at `jobs add --text`; `jobs add --text … --url <that link>` still saves it, fetching nothing.
- [x] A feed watch on Work at a Startup is refused, and a feed item linking there is dropped.
- [x] `termsFor` calls `account.ycombinator.com` and a trailing-dot host prohibited, leaves
      `news.ycombinator.com` and a lookalike host (`ycombinator.com.example.com`) alone.
- [x] lint, typecheck, test green.

## Out of scope
- Reading YC's terms or building a YC reader (needs the hosts allowed or Paul's quotes, #477).
- `news.ycombinator.com` and `hn.algolia.com` (NS-282 slice 1).

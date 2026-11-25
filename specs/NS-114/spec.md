# NS-114: Link ingest + extension capture

Status: approved by Paul (2026-11-25)
Requirements: SRC-001, SRC-006 (deterministic part), SRC-009 (posting and first-seen times);
SRC-002 moved to a follow-up (see Out of scope)
Rules that apply: ADR-0003 (sourcing boundaries), ADR-0004 (provenance), ADR-0006, ADR-0012,
ADR-0013, `.claude/rules/db.md`, `llm.md`, `tests.md`, `gateways.md` (job sources)

## Why
Every later step (scoring, tailoring, applying) starts from a `Job`. Today a job is a title and a
URL. Paul needs to hand Northstar any posting he finds, a Greenhouse link, a Workday page, a
company's careers page, and get back one clean, structured job within 30 seconds, without
duplicates when the same role shows up twice.

## Behavior

### Adding a job (SRC-001)
- `jobs add <url>` fetches the posting and stores a normalized `Job`: title, company, location,
  remote policy, salary range, seniority, requirements, nice-to-haves, apply URL, ATS type and
  posting date, plus the description text. It prints the job's id and which fields it found.
- `jobs add --text <file>` takes a job description Paul saved himself (for LinkedIn and other
  auth-walled sites, ADR-0003, until the extension exists), with `--url` for where it came from.
- **Extraction, most reliable first; plain code wherever the page offers structure:**
  1. **ATS APIs**, chosen from the URL: Greenhouse (`boards-api.greenhouse.io`), Lever
     (`api.lever.co/v0/postings`), Ashby (`api.ashbyhq.com/posting-api`) and Workday (the
     tenant's public `wday/cxs` JSON). These are the public endpoints the boards themselves use.
  2. **schema.org `JobPosting` JSON-LD** in the page (most careers pages publish it for search
     engines).
  3. **Otherwise the `job-extract` route** (new, `claude-opus-5-5`, low effort): the page text
     inside an untrusted block, no tools. Plain code then checks that every extracted value
     appears in the page (ADR-0004); a value that fails the check is dropped, not guessed.
- **Never a silent drop.** If title or company can't be found, the job is stored as a `draft`
  listing the missing fields, and `jobs set <id> <field> <value>` fills them in (SRC-001).
- **Refused on purpose:** LinkedIn, Indeed and Glassdoor URLs are never fetched (ADR-0003); the
  command says to use `--text`.

### Fetching safely
- `https` only, at most 5 redirects, 15 s timeout, 2 MB cap.
- No private, loopback or link-local addresses, checked for every redirect target after DNS
  resolution, so a link can't make Northstar read something on Paul's own network.
- One fetch per URL; no crawling of other pages on the site.

### One job per role (SRC-006, deterministic)
A posting seen again joins its existing `Job` as another `job_source` instead of creating a new
job. The match is plain code, in this order:
1. the same ATS posting id (Workday requisition ids are scoped by tenant, since two companies can
   both have `R-00123`);
2. the same canonical URL (tracking parameters and any user name or password removed);
3. the same normalized company and title, the same place (one location's words contained in the
   other's, so "San Francisco, CA" and "San Francisco, CA, US" agree; a missing location doesn't
   block a match), and descriptions at least 85% alike (word shingles).

Merges are recorded; `jobs list` shows a job once with each place it was seen.

### Freshness (SRC-009)
Each job stores the source's `posted_at` (when the page gives one) and its own `first_seen_at`.
`jobs list` sorts newest first and shows "posted N h ago".

## Acceptance criteria
- [ ] Greenhouse, Lever, Ashby and Workday URLs each produce a job with ≥ 90% of the fields the
      fixture holds, from recorded API responses (tests).
- [ ] A careers page with JSON-LD produces a job with no model call (test).
- [ ] A page with no structure goes to `job-extract`; a value not in the page is dropped (tests).
- [ ] A page with no findable title or company is stored as a `draft` naming the missing fields,
      and `jobs set` completes it (tests).
- [ ] LinkedIn, Indeed and Glassdoor URLs are refused without any network call (test).
- [ ] The fetcher refuses `http://`, private and loopback addresses (including via a redirect),
      bodies over 2 MB and more than 5 redirects (tests with a fake resolver and fetch).
- [ ] The same role from Greenhouse and from its company careers page is one job with two
      sources (SRC-006, test).
- [ ] Adding the same URL twice changes nothing (test).
- [ ] `job-extract` has an eval set in `evals/job-extract/` (≥ 20 synthetic pages, including
      prompt-injection pages), registered, with Paul's `--record` baseline.
- [ ] Events carry ids and counts only: `job.ingested`, `job.merged`, `job.draft_completed`.
- [ ] `pnpm turbo run lint typecheck test build` and `eval --all` pass.

## Failure modes
- **Site slow or down:** timeout after 15 s, no retry; the command says so and nothing is stored.
  Paul reruns it.
- **ATS API changed shape, refused, too big or timed out:** that source is skipped, and
  extraction falls through to JSON-LD, then the model, so a working page still produces a job.
  (Ashby's API returns a whole board and can pass the 2 MB cap.)
- **Model refused, truncated or invalid output:** the job is stored as a `draft` with what plain
  code found.
- **Model down (Claude API unreachable):** changed while building: `jobs add` stops with "Not
  added, try again later" and stores nothing. `.claude/rules/llm.md` says to let the transport
  error surface, and an empty draft of a page Paul can simply re-add is worth little.
- **A redirect or short link (`lnkd.in`) to a prohibited site:** refused on that hop, nothing
  requested from it. Terms are checked on every hop, not only the pasted link.
- **A page's apply link** is resolved against the page, kept only if http(s), with any user name
  or password removed; anything else is dropped. For the Apply Gateway (NS-120): apply only on a
  host that matches the job's source or ATS, never on the stored apply link alone.
- **Database down:** fails before any fetch.

## Observability
- Events: `job.ingested` (job id, extraction method, ATS, fields found, draft, and the model
  call's record when the model read it), `job.merged` (job id, source count),
  `job.draft_completed`.
- Spans: `source.fetch` (host, status, bytes, redirect count; never the path or content),
  `job.ingest` (input kind, method, outcome), plus `llm.call` from the gateway.
- Still untrusted later: titles, requirements and descriptions are copied from pages. The
  provenance check stops invented values, not text that is really on a hostile page, so every
  later route that reads `job.*` wraps it in `untrustedBlock`, and the UI renders it escaped.

## Out of scope
- **SRC-002, the browser extension: moved to a follow-up.** The extension rules require it to
  talk only to the Northstar API with its own token, and no API exists until `apps/api` lands.
  `jobs add --text` covers auth-walled pages until then. Proposed follow-up: "Extension capture"
  after the API ticket.
- **Embedding-based dedupe (SRC-006's description embedding).** It needs an embeddings provider
  (Anthropic has none), so a vendor choice, a dependency and an ADR. The plain-code match above
  meets the acceptance criterion; embeddings can join later behind the same match function.
- Scoring, preferences, the feed UI and ATS board polling (NS-115, NS-116).
- Liveness checks (SRC-010).

## Open questions
1. **Package:** `packages/sources` (job sources and ATS clients, listed as planned in AGENTS.md)
   holds the fetcher, extractors, dedupe and the `jobs` CLI. NS-115 reuses its ATS clients.
2. **Schema change:** expand `job` (the new fields, `status` draft/ready, `posted_at`,
   `first_seen_at`, description text) and add `job_source`. Expand-only (RES-011).
3. **Your paid run:** `eval job-extract --record --update-baseline` before merge, as with NS-113.
4. **Inferred thresholds:** 85% shingle similarity, 2 MB cap, 15 s timeout, 5 redirects.
5. **Size:** roughly 2,000–2,500 lines with tests and fixtures, over the 300-line line.

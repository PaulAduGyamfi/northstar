# NS-282: Permissive job feeds: HN Who's Hiring, YC jobs and RSS/JSON boards

Status: slice 1 in progress (autonomous lane, ADR-0016)
Issue: #460 (parent #13, NS-114)
Requirements: SRC-001, SRC-003, SRC-006, SRC-012…016, RES-002, RES-003, RES-008, OBS-001
Rules that apply: ADR-0003 (sourcing boundaries), ADR-0007, ADR-0015 (plain scheduler),
ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/db.md`

## Why
Only ATS boards and Workday career sites are polled today. Jobs also appear first in public,
permissive feeds: the monthly Hacker News "Ask HN: Who is hiring?" thread, YC's job listings and
plain RSS/Atom or JSON job feeds. Reading them, within each source's terms, finds fresh roles that
no watched board shows (SRC-012…016).

## Behavior
Built in slices, each its own PR. Every feed is a watch like a board (`company_watch`): Paul adds
it with `jobs watch add <url> --tier N`, it is polled by `pollDue` under its own `source:<kind>`
switch and breaker, with the same per-watch backoff and quarantine, and each item goes through
the same save path as a board posting (dedupe SRC-006, scoring, freshness order).

1. **Hacker News "Who is hiring?" (this slice).**
   - `jobs watch add https://news.ycombinator.com/submitted?id=whoishiring` adds kind `hn_hiring`
     (board `whoishiring`). Nothing else on news.ycombinator.com is a watch.
   - A poll makes two requests to HN's public Algolia search API (`hn.algolia.com`, documented,
     no login; terms `official-api`): the newest "Ask HN: Who is hiring?" story by the
     `whoishiring` account, then that story's item with its comments. Only top-level comments are
     postings; replies, deleted and dead comments are skipped. At most `MAX_POSTINGS`.
   - A comment's text is untrusted. Plain code reads it: HTML to text, then the first line's
     `|`-separated fields by HN's own convention (company first). The company is the first field;
     the title is the first field naming a role word (engineer, developer, designer, scientist,
     manager, …); the location is a field with a remote/onsite word or the remaining place field;
     `remote` from the words REMOTE / ONSITE / HYBRID. A comment whose first line doesn't follow the
     convention keeps no title or company and is stored as a draft (Paul can `jobs set` it). No
     model reads it in this slice.
   - The posting's link is `https://news.ycombinator.com/item?id=<comment id>`, its posted date
     the comment's time, its description the whole comment text (bounded).
   - Migration: `company_watch.ats` gains `hn_hiring` (its CHECK lists the watch kinds, a new
     `WATCH_KINDS` constant). Jobs from a feed have no ATS.
2. **RSS/Atom and JSON Feed boards.** `jobs watch add <feed-url> --feed`: a feed Paul names
   (https, public host, read through `safeFetch`). JSON Feed needs no new dependency; RSS/Atom
   needs an XML parser, a dependency decision recorded then. Items without a structured company go
   in as drafts, or through `job-extract` when it is on, with its provenance check.
3. **YC jobs**, only if YC's terms allow automated reads of a public listing. If they don't, the
   source is declared `prohibited` and refused, and this slice closes as "won't read".

## Acceptance criteria
- [ ] Slice 1: `detectBoard` takes the HN `whoishiring` URL (and nothing else on HN) as
      `hn_hiring`; `termsFor` calls `hn.algolia.com` `official-api`.
- [ ] Slice 1: `listBoard` for `hn_hiring` reads the newest thread and its top-level comments from
      recorded synthetic fixtures; a pipe-convention comment becomes a job with company, title,
      location, remote kind, posted date and link; any other comment becomes a draft; replies,
      deleted and dead comments are skipped. No test calls the network.
- [ ] Slice 1: the poll stores them through the existing path under `source:hn_hiring`; a second
      poll stores nothing new; a feed item that duplicates a saved job merges (SRC-006).
- [ ] Slice 1: migration widens `company_watch_ats_valid` to the watch kinds; `app-role.test.ts`
      and `db:generate` stay clean.
- [ ] AGENTS.md lists the new `jobs watch add` forms; README's Status says what is polled.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Failure modes
- Algolia slow or down: `safeFetch`'s limits, the watch backs off and quarantines after 5
  failures (RES-002/003); the `source:hn_hiring` breaker opens on 5xx, 429 or no answer.
- An unexpected reply shape: `BoardUnavailable`, the watch backs off; nothing is guessed.
- No thread this month yet: the newest found is used; an older thread's comments are already
  known and store nothing.
- A comment that lies (a fake company): stored as the posting says, scored like any job; it never
  acts on anything. Text is never an instruction (NFR-SEC-004).

## Observability
- The existing `source.poll` span with `source.ats = hn_hiring` and counts; `job.*` events from
  the save path (ids, counts, methods; never a title, company or URL).

## Out of scope
- Comment replies, edits after first save, and HN threads other than "Who is hiring?".
- Any login, LinkedIn, Indeed or Glassdoor (ADR-0003).

## Decisions made without Paul
- A schema change (the watch-kind CHECK), and the Algolia HN API as the read path: it is HN's
  documented public search API and returns a thread in one request, where the Firebase API needs
  one request per comment.

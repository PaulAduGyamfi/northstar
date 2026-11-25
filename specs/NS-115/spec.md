# NS-115: ATS board polling with freshness SLOs and fresh-first queue

Status: draft
Requirements: SRC-003, SRC-009, SRC-012 (tier cadence; adaptive timing deferred), SRC-013 (the
freshness half), SRC-014 (posted → detected), RES-002/003 (per-board backoff and quarantine);
SRC-015 deferred (see Out of scope)
Rules that apply: ADR-0001 (Proposed), ADR-0003, ADR-0007, a new ADR-0015 (below),
`.claude/rules/gateways.md`, `db.md`, `tests.md`

## Why
Freshness is the top sourcing priority (D-01, SRC-012): early applicants get the attention.
NS-114 reads a job when Paul pastes a link; nothing yet notices a new posting on its own. This
ticket watches the boards of companies Paul cares about and adds every new posting within
minutes, newest first, so he hears about a role before most applicants do.

## Behavior

### The watchlist (SRC-003)
- `jobs watch add <board-url> --tier 1|2|3` adds a company's job board. The URL is the board
  itself, e.g. `https://boards.greenhouse.io/globex`, `https://jobs.lever.co/initech`,
  `https://jobs.ashbyhq.com/hooli`, `https://jobs.smartrecruiters.com/Acme`,
  `https://apply.workable.com/umbrella`. Plain URL parsing picks the ATS and board id.
- `jobs watch list` shows each board: tier, last successful poll, new jobs found, and status
  (`ok`, `backing off`, `quarantined`). `jobs watch remove <id>` stops watching.
- Tiers set the cadence (SRC-012): tier 1 ("dream") every 10 min, tier 2 every 20 min, tier 3
  every 60 min. That keeps the posting-to-feed time under each tier's SLO (15 min, 30 min,
  2 h) with room for one failed poll.

### Polling (SRC-003, SRC-009, SRC-014)
- `jobs poll` runs one pass: every board whose next poll is due is read once through its public
  board API (one request per board: Greenhouse `?content=true`, Lever `?mode=json`, Ashby, and
  SmartRecruiters and Workable's public posting endpoints), through `safeFetch`.
- Each posting is diffed against what's stored (ATS posting id, SRC-006). Only new ones are saved,
  through the NS-114 write path, so a role seen before is never added twice. A posting appearing
  on a board for the first time gets `first_seen_at` = when the poll saw it; `posted_at` comes
  from the board when it gives one. The gap between them is the detection lag (SRC-014).
- `jobs run` keeps polling: it wakes once a minute and runs `jobs poll`. It's a plain long-running
  process Paul starts in a terminal; all state (last poll, failures) is in Postgres, so stopping
  and restarting it loses nothing.

### Fail small (RES-002, RES-003)
- A board that fails (timeout, refusal, 5xx, a response that doesn't validate) is retried on its
  next due time with backoff: its interval doubles per consecutive failure, up to 6 hours.
- After 5 consecutive failures it is `quarantined` and skipped until Paul runs
  `jobs watch retry <id>`. Other boards keep running.
- One board's failure never stops the pass.

### Fresh-first order (SRC-013, freshness half)
- `jobs list` orders by a freshness score: `0.5 ^ (age_hours / 24)`, where age is from `posted_at`
  (or `first_seen_at`), so a 20-minute-old job outranks a 5-day-old one.
- Fit doesn't exist yet (NS-116); the score is one plain function, `queueScore(freshness, fit)`,
  with fit taken as neutral until scoring lands. NS-116 fills the fit half without touching the
  queue code.

## Acceptance criteria
- [ ] `jobs watch add` parses each of the five ATS board URL shapes and refuses anything else
      (tests).
- [ ] Each board client maps a recorded board response to postings with ATS ids (tests, synthetic
      fixtures, no network).
- [ ] A poll saves only postings not already stored; polling the same board twice adds nothing
      the second time (tests).
- [ ] A posting seen first by a link paste and later on its board is one job (SRC-006, test).
- [ ] Only due boards are polled, by tier interval (test with an injected clock).
- [ ] A failing board backs off (interval doubles, capped at 6 h) and is quarantined after 5
      failures; other boards still poll in the same pass (tests).
- [ ] `jobs list` puts a 20-minute-old job above a 5-day-old one (test).
- [ ] Synthetic SLO check: a tier-1 board gets a new posting; with `jobs run`'s 1-minute tick and
      a 10-minute cadence, the job is stored ≤ 11 minutes later in a simulated clock (test).
- [ ] Events: `source.polled` per board (counts: postings seen, new, failed) and the existing
      `job.ingested`; no titles, companies or URLs (test).
- [ ] Spans: `source.poll` (ATS, board id hash, status, counts) and the existing `source.fetch`.
- [ ] `pnpm turbo run lint typecheck test build` and `eval --all` pass.

## Failure modes
- **Board down, slow or changed shape:** that board backs off, then quarantines; the pass goes
  on. `jobs watch list` shows it.
- **Network down entirely:** every board fails this pass and backs off; nothing is lost, and the
  next pass after the network returns catches up (postings carry their own `posted_at`).
- **Database down:** the pass fails before any request; `jobs run` logs it and tries again on the
  next tick.
- **`jobs run` stopped (laptop asleep):** nothing polls; on restart, every overdue board is due at
  once and is read in that pass.

## Observability
- Events: `source.polled` (board id, ATS, seen, new, outcome), `source.quarantined`,
  `job.ingested` (from NS-114).
- Spans: `source.poll` per board, `source.fetch` per request.

## Out of scope
- **Temporal (`SourcingWorkflow`).** A new ADR-0015 records the choice: polling runs as a plain
  scheduler with its state in Postgres, not a Temporal workflow, for now. Polling needs no human
  waits or signals, and Temporal brings new dependencies whose test harness downloads a server
  binary (tests may not use the network). The poll function is written so a Temporal activity
  can call it unchanged when workflows arrive (likely NS-119, the Approval Gate, which needs
  signals).
- **Fresh-job alerts (SRC-015):** push needs the web app (PWA). Follow-up with the app ticket.
- **Adaptive cadence by posting hours (SRC-016, P2)** and **liveness / closed postings (SRC-010,
  P2).**
- The fit half of the queue (NS-116); package, approval and submit timestamps (NS-119, NS-120).

## Open questions
1. **ADR-0015: a plain scheduler instead of Temporal for polling, for now.** My recommendation;
   your call. The alternative is to add the Temporal SDK in this ticket.
2. **Tier cadences** (10, 20, 60 min) and backoff (double, 6 h cap, quarantine at 5) are mine.
3. **Workable's** public endpoint is a POST search API; if it needs anything beyond a plain
   request, Workable drops to a follow-up rather than adding a workaround.
4. **Size:** roughly 1,500–2,000 lines with tests and fixtures, again over the 300-line line.

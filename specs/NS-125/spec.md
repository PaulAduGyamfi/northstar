# NS-125: Activity feed, health model (slice 1: plain-code core)

Status: autonomous lane (ADR-0016), not reviewed by Paul before work started
Requirements: RES-013 (health model), OBS-002 (feed in plain sentences; the text part),
OBS-001 (reads the domain events it requires). RES-008's kill switches already exist (NS-126);
this slice shows them. GitHub issue #24.
Rules that apply: ADR-0007 (fault isolation), ADR-0008 (observability), ADR-0012 (events),
AGENTS.md ("if it isn't in the feed, it didn't happen"), `.claude/rules/db.md`,
`.claude/rules/tests.md`

## Why
Paul: *"I know what's happening behind the scenes and the statuses of everything"* (S2), and
*"I'll be the engineer this is handed off to"* (requirements 14). NS-126 stores breakers and kill
switches, and NS-115 quarantines failing boards, but nothing turns that state into one answer to
"is anything broken, and why?", and the event log has no plain-sentence view. Both are plain code
over data that already exists, so they come before the web app that will show them.

## Behavior
1. **Health model (RES-013)**, `packages/domain/src/health.ts`, pure: `systemHealth(input)` takes
   the breakers, kill switches and board watches, and returns one entry per subsystem with
   `healthy`, `degraded` or `down` and a plain reason, plus an overall status.
   - Breaker `open`: the dependency is `down` ("Paused after repeated failures (RateLimited)"),
     with `retryAt`. `half_open`: `degraded` ("Recovering: one test call allowed"). `closed`:
     `healthy`. Only an open breaker carries `retryAt`.
   - Kill switch off: the subsystem is `down` ("Switched off by you" or "… by Northstar", plus
     the reason that was given). On: `healthy`. The reason is shown here, on Paul's health view,
     never in the feed: `feedLine` shows no payload free text (a comment in `kill-switch-write.ts`
     still says the feed shows it; that comment is now stale).
   - A board watch `quarantined`: `degraded` ("Quarantined after 5 failed reads; retry it with
     `jobs watch retry`"). `backing_off`: `degraded` ("Backing off after 2 failed reads"). `ok`:
     `healthy`. Boards are named by ATS and watch id only (events and spans never carry a board
     name; this view is Paul's own, but it follows the same rule so it can be logged).
   - Overall: `healthy` when every entry is; otherwise `degraded`. `down` overall is reserved for
     "can't read the state at all" (Postgres down), which the reader reports by throwing.
   - Entries are sorted worst first, then by name, so the first line is what needs attention.
2. **Reading it**, `packages/db/src/health-read.ts`: `readSystemHealth(db, candidateId)` reads
   breakers, kill switches and watches and returns `systemHealth` of them.
3. **Feed lines (OBS-002)**, `packages/domain/src/feed.ts`, pure: `feedLine(event)` turns a
   stored event into one plain sentence, e.g. `breaker.opened` → "Paused anthropic after 5
   failed calls (RateLimited)"; `kill_switch.set` → "You switched off auto_apply";
   `application.submitted` → "Application moved from submitting to submitted". It reads only
   named payload fields of known types (ids are never shown, free text only from `reason`), and
   any event without a template falls back to its `reason`, then to its type in words. A value
   of the wrong shape is treated as missing, so a bad payload can't break the feed.
4. **Reading the feed**, `packages/db/src/feed-read.ts`: `readFeed(db, candidateId, { before?,
   limit })` returns the newest events first, each with its position, time, type, actor and
   line. `before` pages backwards; `limit` is 1 to 200.

## Acceptance criteria
- [ ] Each breaker, kill-switch and watch state maps to the health and reason above (domain tests).
- [ ] The overall status is `healthy` only when every subsystem is (domain test).
- [ ] `readSystemHealth` on PGlite reports an opened breaker, a switched-off subsystem and a
      quarantined board, worst first (db test).
- [ ] Every event type written today has a feed template; unknown types fall back to `reason`,
      then to the type in words; a malformed payload never throws (domain tests).
- [ ] `readFeed` returns newest first, pages with `before`, and refuses a limit outside 1–200
      (db test).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0.

## Failure modes
- **Postgres down:** both readers throw; the caller (a future API) shows its maintenance state.
- **A writer adds an event type without a template:** its line falls back to `reason`, so
  nothing disappears from the feed; a test lists the known types so a new one is noticed.
- **A payload field is missing or the wrong type:** the template leaves it out.

## Observability
Readers only: no events written. Spans `health.read` and `feed.read` with counts.

## Out of scope (follow-up issues)
- The UI: the System Health page, the header status dot, the live feed with SSE/WebSocket push
  within 5 s, and kill-switch toggles. All need `apps/web` and `apps/api`, which don't exist.
- Run inspector (OBS-003): needs LLM call records joined to workflow runs (Temporal).
- Names in feed lines (company, role): needs joins from the aggregate id to jobs and
  applications, and a rule for what the feed may show.
- Health for worker pools and Temporal (RES-001): no workers yet.

## Open questions
- A switched-off subsystem is reported `down` (it isn't running). If Paul prefers "paused" as
  its own state, RES-013 needs a fourth value.

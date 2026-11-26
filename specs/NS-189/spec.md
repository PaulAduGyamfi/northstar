# NS-189: Show job and company names in the app's activity feed

Status: accepted (autonomous lane, ADR-0016)
Requirements: OBS-002 (live activity feed in plain sentences, "Tailored resume for Stripe")
Rules that apply: `.claude/rules/db.md` (feed text only from `feedLine`; events carry ids, never
names), `.claude/rules/web.md`, `.claude/rules/tests.md`, ADR-0012, ADR-0018
Parent: #99

## Why
NS-153 shows the activity feed in the app with `feedLine` text only. Events carry ids, never a
company or role name, so a line reads "Tailored a resume" and Paul can't tell which job it was
about without opening something else.

## Behavior
1. **`packages/db`.** `FeedItem` gains `aggregate` (the event's aggregate id, as stored).
   `readFeedNames(db, candidateId, aggregates)` (`feed-read.ts`) takes aggregate ids, keeps the
   ones shaped `job:<uuid>` or `application:<uuid>`, and returns a map from each such aggregate to
   `{ jobTitle, company }`, read from the candidate's own `job` (and its `company`), through the
   application's job for `application:`. Aggregates of another candidate, unknown ids and other
   kinds are absent from the map. Read-only, one span (`feed.names`), at most two queries.
2. **`apps/api`.** `SystemPorts` gains `feedNames`. `GET /feed` reads the page, then the names of
   its aggregates, and returns each item with two new fields, `jobTitle` and `company` (each a
   string or `null`). The `line` text is unchanged: names are never written into it, never stored
   in events, and the aggregate id itself is not returned. If the names can't be read, the page
   is still returned, with `null` names (fail small).
3. **`apps/web`.** The feed schema takes the two fields. `feedSubject` (`src/system.ts`) makes the
   label: "Title at Company", or whichever one is known, or nothing. `LiveFeed` shows it after the
   line as plain text (React escapes it; no HTML from data).

## Acceptance criteria
- [ ] `readFeedNames` returns title and company for `job:` and `application:` aggregates of the
  candidate, `null` company for a draft job without one, and nothing for another candidate's job,
  a malformed id or another aggregate kind (PGlite, synthetic `example.com` jobs).
- [ ] `readFeed` items carry their aggregate.
- [ ] `GET /feed` returns `jobTitle` and `company` per item from the port, `null` where none, and
  the same `line` text; when the names port throws it still answers 200 with `null` names.
- [ ] `feedSubject` renders both, either one, or `null`.
- [ ] `/verify` green for `packages/db`, `apps/api`, `apps/web`.

## Failure modes
- Postgres down: the feed read itself fails as before; a names read that fails alone leaves the
  lines without names.
- A deleted or other candidate's job: no name, the line still shows.

## Observability
Span `feed.names` with `northstar.feed.names` (how many aggregates got a name). No new events:
names are read, never written.

## Out of scope
Names for other aggregates (tailored resumes, approvals, handoffs naming an application in their
payload); a name in the pipeline timeline; storing names anywhere.

## Open questions
None. The label format ("Title at Company") is inferred from OBS-002's example.

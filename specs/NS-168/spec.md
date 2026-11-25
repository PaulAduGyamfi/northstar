# NS-168: Pipeline board and application timeline (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: DSH-001 (board by status), DSH-006 (application timeline); DSH-002, DSH-003,
DSH-004 follow up
Rules that apply: ADR-0012, ADR-0018; `.claude/rules/web.md`, `db.md`, `tests.md`; UX-020

## Why
Paul can see the activity feed and the approval queue, but not his applications themselves: what
state each one is in, and what has happened to it. DSH-001 asks for a board of applications by
status and DSH-006 for each one's timeline. Both are read-only views over records that already
exist (`application`, `job`, `company`, `domain_event`).

## Behavior
1. **Reads** (`packages/db`, `pipeline-read.ts`, read-only, no migration):
   - `listApplications(db, candidateId)`: every application with its status, the job's title,
     company name and ATS, and when it was created and last changed, newest change first, at most
     500.
   - `readApplicationTimeline(db, candidateId, applicationId)`: the application's summary and its
     events, oldest first. Each line is built only by `feedLine` (`packages/domain`), never raw
     payloads. An event belongs to the timeline when its aggregate is `application:<id>` or its
     payload names the application (`applicationId`): handoffs, submissions and mail links.
     Another candidate's application reads as not found.
2. **API** (`apps/api`, `pipeline.ts`, `auth: "session"`):
   - `GET /applications`: the list.
   - `GET /applications/timeline?id=`: the timeline, or 404.
   - Either answers 503 when the database can't be read.
3. **Web** (`apps/web`, the Pipeline tab, `/pipeline`, behind `readApi`):
   - A board with one column per status that has applications, in the state machine's order.
     Each status is shown in words from UX-020's vocabulary (`.status-label`, never colour
     alone): found, queued, awaiting you, submitting, submitted, needs your hands, in process,
     offer, closed.
   - Each card shows the job title, company and how long since it last changed, and links to its
     detail page.
   - `/pipeline/<id>`: the application's title, company and status, and its timeline.
   - Plain logic in `src/pipeline.ts`: status words, grouping, the timeline view. It is tested
     without a browser.

## Acceptance criteria
- [ ] `listApplications` returns only the candidate's applications, newest change first, with
      title, company and ATS (PGlite test).
- [ ] `readApplicationTimeline` includes the application's own events and events whose payload
      names it, oldest first, as feed lines, and never another application's events; another
      candidate's id reads as not found.
- [ ] Both endpoints refuse a request without a session; an id that isn't a uuid is 400; an
      unknown one is 404.
- [ ] Every application status has a word, and rejected, withdrawn and ghosted all read
      "closed" (UX-045, web test).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Postgres down:** both endpoints answer 503, and the page says the pipeline can't be read.
- **A job with no title or company yet (a draft):** the card says "Untitled job" or "Unknown
  company" instead of failing.

## Observability
Read-only. The reads run in `db.pipeline.*` spans with counts; the API adds `api.request`. No
events.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #119`)
- DSH-001 filters (company, score, source, date) and a table view.
- DSH-002 funnel metrics and time in stage.
- DSH-003 Today counts (approvals waiting, needs-human, interviews, follow-ups, growth blocks).
- DSH-004 source and variant analytics.
- DSH-006's documents sent and answers used, which need stored packages (NS-161).

## Open questions
- Are 500 applications enough for the board before paging? It's far above a year of applying.

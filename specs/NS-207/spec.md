# NS-207: Pipeline filters and table view, and the Today counts of what needs Paul

Status: accepted (autonomous lane, ADR-0016)
Requirements: DSH-001 (filters, table), DSH-003 (Today)
Rules that apply: ADR-0018, `.claude/rules/web.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #119

## Why
The Pipeline tab shows a board with no filters, and Today shows the feed and "Needs your hands"
but not how much else waits on Paul.

## Behavior
1. **packages/db** (`pipeline-read.ts`, read only, no migration): `listApplications(db,
   candidateId, filter)` takes an optional filter, applied in SQL:
   - `company`: the company name contains it, case-insensitively (at most 100 characters);
   - `band`: the job's latest fit score band (`queue`, `suggest`, `skip`);
   - `source`: the job's ATS (`greenhouse`, …), or `other` for a job with none;
   - `from` / `to`: the application's creation day, inclusive (`YYYY-MM-DD`, UTC).
   Each row also carries the job's latest fit score and band (null when unscored).
2. **apps/api** `GET /applications` takes the same query fields. A bad one, or `from` after `to`,
   is 400; the fit score and band are in each item.
3. **apps/web**:
   - `/pipeline` has a filter form (GET, so the filters live in the URL and a view can be
     bookmarked) and a Board / Table switch that keeps them. The table lists title, company,
     status in words, fit and last change. `src/pipeline.ts` holds the plain logic
     (`parseFilters`, `filterQuery`, `tableRows`).
   - Today shows counts that link to their pages: approvals waiting (the Queue), needs your
     hands, and "not set up yet" for follow-ups, interviews and today's growth block, never 0.

## Acceptance criteria
- [ ] Each filter narrows the read on PGlite, and they combine.
- [ ] The API refuses a bad band, source, date or range with 400, and passes the filter through.
- [ ] `parseFilters` keeps only valid fields, and `filterQuery` round-trips them.
- [ ] Today's counts equal the Queue's and the handoffs' own lists (a test of `todayCounts`).
- [ ] Every status is still shown in words (UX-020).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
API down: the page says so and shows nothing else. A count that can't be read says "can't be read
right now", never 0.

## Observability
The existing `db.pipeline.list` span, with the number of filters used.

## Out of scope
Interviews (NS-169/170), follow-ups (NS-166) and growth blocks (NS-210) counts: shown as not set
up yet. Saved views.

## Decisions made without Paul (ADR-0016)
- **"Source" is the job's ATS** (or `other`): the one source field every job has. Board versus
  link versus browser capture can come with the source analytics (NS-208).
- **"Score" is the band**, not a number range: the bands are what Paul acts on (MAT-003).

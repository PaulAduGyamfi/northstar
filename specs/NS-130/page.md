# NS-130 slice 8: the Career DNA page

Status: in progress (autonomous lane, ADR-0016; Paul agreed to the page about 04:20Z)
Issue: #54
Requirements: DNA-001 (the report shown with its evidence counts), DNA-008 (history: what changed)
Rules that apply: ADR-0016, ADR-0018 (session sign-in), AGENTS.md (`apps/api` endpoint pattern),
`.claude/rules/web.md`, `.claude/rules/db.md` (career DNA reports), `docs/design/tokens.md`

## Why
The report is built and stored (slices 1–7), but Paul can read it only through `profile dna` in a
terminal. DNA-008 says "what changed" is the reason to come back; it belongs in the app.

## Behavior
- `GET /career-dna` (`apps/api`, `auth: "session"`) reads `readCareerDnaHistory` and answers:
  - `{ report: null }` before any report is stored;
  - otherwise the newest version's number and date, its label (or null), each dimension's key,
    rubric label, band, points (null while thin) and evidence count in rubric order, and
    `changes`: `changeLines(diffCareerDna(previous, newest))`, fixed sentences.
  It never carries atom or story ids or text: the stored snapshot has no text, and ids aren't
  useful on a page. The response is Zod-checked like every endpoint.
- `@northstar/api` depends on the workspace package `@northstar/profile` for `diffCareerDna`,
  `changeLines` and `CAREER_DNA_RUBRIC` (one place for the wording; never a copy).
- A read-only page at `/career-dna` (`apps/web`, new files only) says the report in words: the
  label, each dimension as "High · 12 items", "Not enough evidence yet · 2 items", and the changed
  lines, or "Your first report" / "Nothing changed since the last version". Without a report it
  says how to build one (`profile dna`). No chart (radar or bars is Paul's call) and no nav link
  in this slice (another agent is in `apps/web`'s shared files).

## Acceptance criteria
- [ ] `GET /career-dna` answers 401 without a session (test).
- [ ] With no report it answers `{ report: null }`; with two versions it answers the newest one's
      dimensions and the change lines between them (tests on a fake reader).
- [ ] No atom or story id appears in the response (test).
- [ ] The page's words come from a plain function with tests (band words, counts, empty states).
- [ ] `node_modules/.bin/turbo run lint typecheck test build --force` green for touched packages.

## Failure modes
- The database read fails: the endpoint answers 500 by the shared pattern and the page says the
  report couldn't load; nothing else on the page breaks.
- A stored snapshot with a dimension the current rubric doesn't know: shown by its key, never
  dropped.

## Observability
- The `api.request` span as for every endpoint; no new event (a read).

## Out of scope
- Directions and evidence gaps on the page (they need ready jobs and growth tracks read in the
  API), a chart, a nav link, the share card (DNA-007) and Profile Grade (DNA-005).

## Decisions made without Paul
- A dependency: `@northstar/profile` in `@northstar/api` (a workspace package; Paul approves the
  `pnpm add` at its prompt).
- Report and "what changed" only in this slice; directions and gaps later.

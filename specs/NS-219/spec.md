# NS-219 (slice 1): Spend-cap holds on Health

Status: built
Requirements: RES-009 (LLM spend cap), RES-013 (System Health), ADR-0021 (Proposed), UX-043
Rules that apply: ADR-0016, `.claude/rules/web.md`, `.claude/rules/llm.md`,
`.claude/rules/tests.md`. Parent: #127. Part of #212.

## Why
Since NS-176 the LLM gateway holds a route back once today's or this month's spend reaches its
priority's share of a cap (low 80 %, normal 100 %, fresh 125 %). Today that hold shows only on the
`llm.call` span and in a CLI's or the API's held-back message. A paused mail backfill can go
unnoticed for days.

## Behavior
- **`pausedPriorities(spent, caps)`** (`packages/llm`, `budget.ts`, plain code): each priority
  (`low`, `normal`, `fresh`) that `budgetHold` holds back now, with the cap that holds it
  (`daily` before `monthly`, as `budgetHold` decides). Same rule as the gateway, so the page can't
  disagree with what actually runs.
- **API `GET /system/spend`** (`apps/api/src/spend.ts`, `auth: "session"`): today's and this
  month's spend in US dollars, each cap or `null`, and the paused priorities. 503 when spend
  can't be read. Wired in `bin.ts` to the same caps (`loadLlmBudget`) and stored spend
  (`dbSpendMeter`, over `readLlmSpend`) the gateway uses.
- **Web `/health`, a "Model spend" card** (`src/spend.ts`): "Today: $1.20 of the $5.00 daily cap"
  (or "no daily cap"), the same for the month, and one line per paused priority in plain words:
  which work is paused, which cap and share, and when it starts again ("tomorrow (UTC)", "next
  month (UTC)", or sooner if Paul raises the cap). Nothing paused: "Nothing is paused." Unreadable:
  "Spend can't be read right now." Amounts in dollars and cents.

## Acceptance criteria
- [x] `pausedPriorities` lists exactly the priorities `budgetHold` holds, with their cap (tests at
      each share's edge).
- [x] The API answers 401 without a session, the figures and paused list with one, 503 when spend
      can't be read (API tests).
- [x] The page's words for usage, each paused priority and each cap, and "nothing paused" (web
      tests).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope (rest of #212)
- Bounded concurrency per worker pool: there's no worker process yet (#230); its limits arrive
  with the process that uses them.
- A health-dot change or a feed event when a cap starts holding.

## Open questions
- None.

# NS-287: Stop the profile tests' database setup from timing out in CI

Status: approved (autonomous lane, ADR-0016; parent #458)
Requirements: none (test harness only). Issue #476.
Rules that apply: ADR-0012 (PGlite tests), `.claude/rules/tests.md`, `.claude/rules/db.md`.

## Why
`@northstar/profile#test` failed CI on #467 and #473: a `beforeEach` that opens the in-process
PGlite test database (`createTestDb`) passed Vitest's 10 s hook default under CI's full parallel
load. No assertion failed, and the profile package wasn't touched. It blocks unrelated merges.

## Behavior
- The profile package's db-backed suites open one PGlite copy per file (`beforeAll`) where the
  tests don't need an empty database. Each test still makes its own candidate, and any read that
  looked at a whole table now keeps only that test's candidate's rows, so tests stay independent.
  - `src/voice/store.test.ts` (6 db tests) and `src/independent-work-db.test.ts` (3 db tests):
    one database per file, a fresh candidate (and, for independent work, a fresh stored entry)
    per test.
  - `src/reply/nudge.test.ts` and `src/reply/recruiter.test.ts` have one db test each: already
    one database per file, unchanged.
- `packages/profile/vitest.config.ts` sets `hookTimeout: 30_000`, the value `packages/db`'s
  dependents already use (gateways, pipeline, sources, funnel, api, worker; NS-258). It is a setup
  budget for hooks only: no test timeout, assertion or eval threshold changes.

## Acceptance criteria
- [ ] `pnpm turbo run test --force` (every package at once, turbo's default concurrency) passes.
- [ ] `pnpm turbo run lint typecheck test build --filter=@northstar/profile` passes.
- [ ] No assertion, test timeout or eval threshold changed; no test removed or skipped.

## Failure modes
A test that wrote rows another test reads would now see them: every whole-table read is
filtered by the test's own candidate, and each test makes its own candidate.

## Observability
None (tests only).

## Out of scope
Other packages' suites; changing `createTestDb` itself.

## Open questions
None.

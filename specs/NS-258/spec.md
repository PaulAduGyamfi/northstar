# NS-258: per-test timeouts for slow tests under CI's parallel load

Status: done, in review (autonomous lane, ADR-0016)
Issue: #363 (parent #308)
Rules that apply: ADR-0016, `.claude/rules/tests.md` (never loosen an assertion or skip a test)

## Why
CI's `build` job runs every package's tests at once. Twice a test that is fast alone timed out
under that load: the vault boundary test's whole-repository walk (5,025 ms against vitest's
5,000 ms default) and submit-db's PGlite setup hook (vitest's 10 s hook default).

## Behavior
- `packages/gateways/src/vault/boundary.test.ts`: the six tests that read every source file in the
  repository take `REPO_WALK_TIMEOUT_MS` (30 s), with a comment saying why.
- `packages/gateways/src/mail/boundary.test.ts`: the three tests that walk the whole repository
  (not the ones that read only `src/mail/`) take the same limit, for the same reason.
- `packages/gateways/src/apply/submit-db.test.ts`: its `beforeEach` that creates a PGlite database
  takes `PGLITE_SETUP_TIMEOUT_MS` (30 s).
- No global `testTimeout` or `hookTimeout` changes, no assertion changes, no test skipped.
  Biome re-indented the test bodies; the `expect` text and the test count are unchanged.

## Acceptance criteria
- [x] The named tests carry explicit timeouts with comments.
- [x] No assertion changed (the `expect` text compared with whitespace removed).
- [ ] `checks` green (CI: this container's Node 22 can't install the workspace).

## Out of scope
- Other packages' `createTestDb` hooks: no CI timeout seen there yet, and their runtime can't be
  measured here.
- Speeding up the walk.

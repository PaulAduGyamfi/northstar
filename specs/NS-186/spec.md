# NS-186: Score a job right after it is captured from the browser

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: SRC-002 (one-click capture from the browser), with the Fit Score of MAT-001.
GitHub issue #146 (agent-filed, parent #51 / NS-128).
Rules that apply: `.claude/rules/gateways.md` (sources), `tests.md`, AGENTS.md (fail small).

## Why
`jobs add` scores a job right after saving it. A job saved with "Save to Northstar" waits for the
next `jobs score` or poll pass, so the queue shows it unscored.

## Behavior
1. **`CapturePorts.score`** (`apps/api/src/capture.ts`), optional. After a capture ends in
   `created`, `merged` or `unchanged`, the endpoint runs one scoring pass before it answers,
   the same as `jobs add`, which scores after any successful add.
   - `refused`, `not_a_job` and `failed` save nothing, so they don't score.
   - A scoring pass that throws, or ends `no_profile` / `no_preferences`, never changes the
     capture's answer: the job is saved, and the next pass scores it.
   - A throw is named on the `api.request` span (`capture.score_error`, the error's name only).
   - The answer's shape doesn't change.
2. **Wiring** (`apps/api/src/bin.ts`). `scorePending` reads and saves through the same
   packages/db functions `jobs add` uses: `readPreferences`, `readScoringProfile`,
   `readScorableJobs`, `readScoreKeys` and `saveFitScore`. `scorePending` and its types are
   exported from `@northstar/sources`.
3. **Docs.** Remove the "isn't scored until…" note from AGENTS.md and `specs/NS-128/spec.md`.

## Acceptance criteria
- [ ] A capture that creates, merges or finds a job runs one scoring pass, after the save
      (capture tests).
- [ ] A refused, not-a-job or failed capture doesn't score.
- [ ] A scoring pass that throws leaves the capture's answer unchanged (status 200, same body).
- [ ] With no `score` port, captures behave as before (every existing test unchanged).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope
- Fresh-job alerts after a capture (NS-163's alert pass). It needs the alert settings in the
  API; `jobs add`'s next poll or score pass still sends them.
- Showing the score in the extension.

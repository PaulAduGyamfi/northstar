# NS-219 (slice 2): Bounded concurrency per worker pool

Status: built
Requirements: RES-009 (bounded concurrency), RES-001 (a queue per domain), ADR-0003 (human pacing),
ADR-0007. Rules: ADR-0016, `.claude/rules/worker.md`, `.claude/rules/tests.md`. Parent: #127.
Closes #212 with slice 1 (#270).

## Why
Each Temporal task queue (one per domain) needs a ceiling on how much work its worker runs at
once, so a burst backs up in the queue instead of opening many browsers or model calls at once,
and so the spend cap's read-then-record overshoot stays small (ADR-0021, Consequences). The
worker process doesn't exist yet (#230); its limits should be ready, tested and in config when
it does.

## Behavior
- `loadPoolLimits(settings)` (`apps/worker/src/pools.ts`), the one place the limits are read:
  `WORKER_PIPELINE_CONCURRENCY` (default 4, at most 16) and `WORKER_APPLY_BROWSER_CONCURRENCY`
  (default 1, at most 4: one browser at a time unless Paul raises it; the claim ledger still
  allows one submission per ATS and the 90 s gap, ADR-0003). Whole numbers from 1; anything else
  throws naming the setting, never its value. Entry points pass their settings in.
- `workerOptions(queue, limits)`: the Temporal worker options for one pool: its task queue and the
  limit as both its activity and workflow-task concurrency. A full pool leaves tasks waiting in
  Temporal's queue: nothing is dropped.
- Only the two queues that exist (`pipeline`, `apply-browser`); other domains' pools arrive with
  their queues.
- `.env.example` lists both settings, commented out with their defaults.

## Acceptance criteria
- [x] Defaults, valid values, the ceilings and refusals (0, negative, fraction, text, over the
      ceiling) are tested, and a refusal names only the setting.
- [x] `workerOptions` gives each queue its own limit (test).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope
- The worker process that starts the pools (#230).

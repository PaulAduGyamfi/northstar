# NS-225 slice 3: worker health on the Health page

Status: built (autonomous lane, ADR-0016). Slices 1 (#382) and 2 (#385) came first; see `spec.md`.
Issue: #230 (parent #108)
Requirements: RES-013, OBS-002 · ADR-0007
Migration: 0099 (the packages/db lane, given by the orchestrator after #383)

## Why
A stopped worker pool is invisible: Health shows breakers, switches and boards, but not whether the
worker process is running. Nothing would say that submissions and the sweep have stopped.

## Behavior
- `worker_heartbeat` (`packages/db`, `worker-health-schema.ts`, migration 0099): one row per
  candidate and queue (`pipeline`, `apply-browser` by a CHECK), with `enabled`, `started_at` and
  `last_seen_at`. State, not history, like `dependency_breaker`: no append-only trigger; the app
  role gets SELECT, INSERT, UPDATE and DELETE by the NS-212 rule (`northstar_grant_app_role()`).
- `recordWorkerHeartbeat` upserts a beat with `last_seen_at = now()` (the database's clock), and
  `readWorkerHeartbeats` gives each pool's seconds since its last beat, also on the database's
  clock (never negative). Queue names and times only.
- `systemHealth` (`packages/domain`) takes the pools (`workers`, optional): a pool beat within
  `WORKER_STALE_SECONDS` (180) is "Running"; past it, down, "Not running: last seen N minutes
  ago" (hours past two); a pool turned off in the worker's settings is "Turned off in the worker's
  settings", healthy, not a fault. Kind `worker`, subsystem `worker:<queue>`.
- `readSystemHealth` reads them, the API's `GET /system/health` and the web app's Health page pass
  the new kind through (the page lists subsystems as they come).
- The worker (`src/heartbeat.ts`, `startHeartbeats`): after its pools are created it beats for
  both queues at once and every 30 s (`HEARTBEAT_MS`), the browser pool with `enabled: false`
  while it is off, so an older run's beat never reads as a pool that died. Beats never overlap. A
  failed beat logs its error class only and the next one tries again; heartbeats stop when the
  pools stop.

## Acceptance criteria
- [x] `systemHealth`: running, down past 180 s with plain words, off as healthy, hours wording.
- [x] `recordWorkerHeartbeat` keeps one row per queue and moves its beat to now; an unknown queue
      is refused; reads are the candidate's own; `readSystemHealth` shows down and off pools.
- [x] The app role's grants match the table (`app-role.test.ts`).
- [x] The API and the web schema accept the `worker` kind.
- [x] `startHeartbeats`: beats at once and every 30 s until stopped, logs a failed beat by class
      only, skips a beat while one is in flight.
- [x] lint, typecheck, test and build green for domain, db, api, web and worker; docs updated.

## Out of scope
- Heartbeats for the browser steps (slice 4, once the gateway has a step hook).
- Temporal's own poller state: a pool that runs but can't reach Temporal still beats.

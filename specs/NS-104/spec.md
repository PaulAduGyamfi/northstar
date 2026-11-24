# NS-104: Local stack: docker compose (Postgres+pgvector, Temporal, S3 storage, Grafana LGTM, OTel Collector)

Status: approved by Paul (2026-11-24; SeaweedFS, Temporal dev server, otel-lgtm, no profiles)
Requirements: NFR-OPS-001 (single `docker compose up` for local), ADR-0008 (observability),
ADR-0001 (Temporal), ADR-0005 (Postgres 16 + pgvector, S3-compatible storage). GitHub issue #5.
Rules that apply: AGENTS.md (secrets, 14-day cooldown, never `docker compose down -v`),
`.claude/rules/db.md`, `.claude/rules/worker.md`.

## Why
Every later ticket needs a database, a workflow engine, object storage and somewhere to send
traces. One command should bring all of it up on Paul's machine, the same way every time, so the
first line of app code already has observability (ADR-0008).

## Behavior
- `docker compose up -d --wait` starts four services and returns when each reports healthy:
  - **postgres**: Postgres 16 with the pgvector extension available (`CREATE EXTENSION vector`
    works; NS-105's first migration creates it).
  - **temporal**: Temporal dev server with its Web UI, state kept in a volume so workflows survive
    a restart.
  - **storage**: SeaweedFS with its S3 API (replaces MinIO, see open question 1).
  - **lgtm**: Grafana with Loki, Tempo and Prometheus, plus the OpenTelemetry Collector that
    receives OTLP on 4317 (gRPC) and 4318 (HTTP). One image (`grafana/otel-lgtm`) covers both
    "Grafana LGTM" and "OTel Collector".
- Every port binds to `127.0.0.1` only. Nothing is reachable from the network.
- Accepted for local use (review finding): Grafana keeps the otel-lgtm image's default login and
  anonymous access, and the Temporal dev server has no auth. Both are loopback-only. Nothing may
  trust a Temporal signal alone: gateways check the `approvalId` in Postgres (ADR-0002).
- Data lives in named volumes. `docker compose down` keeps it, and `docker compose down -v`
  (deletes data) stays forbidden for agents.
- Credentials come from `.env`, which Paul creates by copying `.env.example` and changing the
  placeholders. Compose refuses to start if a required value is missing, rather than falling back
  to a default password.
- Images are pinned by tag and digest, each released at least 14 days ago. Dependabot watches
  them with the same 14-day cooldown.
- CI validates the compose file (`docker compose config --quiet` with `.env.example`). CI does
  not run the stack.

## Acceptance criteria
- [ ] `docker compose --env-file .env.example config --quiet` exits 0, locally and in CI.
- [ ] `docker compose up -d --wait` exits 0, and `docker compose ps` shows all four services
      `healthy`.
- [ ] `CREATE EXTENSION IF NOT EXISTS vector` then `SELECT extversion FROM pg_extension WHERE
      extname='vector'` prints `0.8.6`.
- [ ] Temporal answers: `temporal operator cluster health` inside the container prints `SERVING`.
      The UI loads at http://127.0.0.1:8233.
- [ ] Storage answers on its S3 port with the `.env` credentials (a bucket can be created and
      listed).
- [ ] Grafana loads at http://127.0.0.1:3000, and its health endpoint reports `ok`.
- [ ] After `docker compose down` and `up -d --wait`, a table created in Postgres is still there.
- [ ] `docker compose ps --format '{{.Publishers}}'` shows only `127.0.0.1` bindings.
- [ ] Without `.env`, `docker compose config` fails and names the missing variable.
- [ ] `checks` is green on the PR, with the compose validation step.

## Failure modes
- **One service won't start:** `--wait` exits non-zero and names it. The others keep running,
  and `docker compose logs <service>` shows why. Each service can be restarted alone.
- **Port already in use:** compose fails on that service with "address already in use". The port
  is a variable in `.env`, so it can be moved.
- **Docker not running:** every command fails at once with Docker's own error. No partial state.
- **A pinned image disappears or its digest changes:** the pull fails loudly. Pick a new pinned
  version 14+ days old. Never unpin.
- **Volume corrupted:** stop that one service and remove only its volume, by name, with Paul's
  approval. Never `down -v`.

## Observability
The stack *is* the observability backend: OTLP in on 127.0.0.1:4317/4318, Grafana on :3000. No app
emits spans yet (NS-105 and NS-106 do). Each container has a healthcheck that `docker compose ps`
shows.

## Out of scope
- App code, migrations, `CREATE EXTENSION` in a migration (NS-105), buckets the app uses, Temporal
  namespaces and workers.
- Dashboards and alerts as code (`ops/grafana/`, `ops/alerts/`). Each arrives with the feature it
  watches.
- A hosted deploy (P2), and running the stack in CI.
- The pre-existing harness issue the NS-108 review raised (unsandboxed `docker compose up` and
  `pnpm test`). This ticket keeps the compose file free of host bind mounts and privileged
  containers, so it doesn't make that worse.

## Open questions
1. **MinIO → SeaweedFS.** ADR-0005 (proposed) says MinIO locally. MinIO stopped publishing
   community images (none on Docker Hub today). SeaweedFS (Apache-2.0) runs as one container with
   an S3 API. Recommendation: SeaweedFS, recorded as a one-line ADR-0005 update. Inferred: its
   S3 admin credentials can be set from environment variables. Task 4 checks this; if they can't,
   I'll stop and ask before adding a config file.
2. **Temporal dev server, not the full server.** `temporal server start-dev` is one container
   with SQLite in a volume, instead of the multi-container server on Postgres. Fine for local and
   single-user (ADR-0001). Hosted (P2) would use the full server.
3. **No compose profiles.** ADR-0008 says LGTM "can be disabled with a compose profile". All
   services start by default, and `docker compose stop lgtm` turns it off. A profile can come
   later if the containers prove heavy.

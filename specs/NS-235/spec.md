# NS-235: keep the database owner's credentials out of the file the apps load

Status: built (autonomous lane, ADR-0016; Paul delegated the decision in chat on 2026-11-27)
Requirements: NFR-SEC (least privilege) · ADR-0011, NS-212 · Issue #257 (Parent: #194)

## Why
NS-212 made the apps connect as `northstar_app`, which can't disable the append-only triggers.
But every app started with `node --env-file-if-exists=../../.env`, and that file also held
`DATABASE_MIGRATION_URL` (the owner) and `POSTGRES_PASSWORD` (a superuser in the pgvector image).
A compromised app process that reads its own environment could still connect as the owner.

## Decision
- The root `.env` stays the owner's file: compose reads `POSTGRES_*` from it on its own, and
  `db:migrate` loads it. No compose change.
- The apps load a new gitignored `.env.app`: the API (`start`) and the `profile`, `jobs`,
  `funnel` and `eval` commands.
- `.env.example` documents both in two marked sections (a separate `.env.app.example` is under the
  harness's `.env.*` deny rule, so it isn't created).
- `loadDbConfig`, which every app connects through, refuses to start while
  `DATABASE_MIGRATION_URL` or `POSTGRES_PASSWORD` is set (non-empty), naming the setting and never
  its value.

## Paul's one-time step
Create `.env.app` with the "Apps" part of `.env.example`, copying the values from his `.env`.
Until then the apps stop with "DATABASE_URL is missing": loud, never silent.

## Acceptance criteria
- [x] An app's `loadDbConfig` refuses either owner setting, naming it, never its value.
- [x] An empty owner setting counts as unset.
- [x] The five app scripts load `.env.app`; `db:migrate` still loads `.env`.
- [x] `.env.example`, AGENTS.md and `.claude/rules/db.md` describe the split.
- [x] Lint, typecheck and the config tests pass in the touched packages.

## Out of scope
- `S3_*` credentials (no app uses storage yet); the worker process (#230) loads `.env.app` when it
  arrives.

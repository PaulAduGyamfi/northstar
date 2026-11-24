# ADR-0008 — Observability stack (OpenTelemetry-first)

**Status:** Proposed · **Date:** 2026-11-24

## Decision
- **Instrumentation:** OpenTelemetry SDKs in every Node process (web, API, workers); Temporal's OTel interceptors to carry trace context across workflows and activities; Anthropic SDK calls wrapped by the LLM Gateway, which emits spans with model/token/cost attributes.
- **Backend:** vendor-neutral via the OTel Collector.
  - Local / self-hosted: **Grafana LGTM** (Loki logs, Grafana, Tempo traces, Mimir/Prometheus metrics), all in docker compose.
  - Hosted option: Grafana Cloud free tier or Honeycomb. Switching backends is a Collector config change only.
- **Errors:** Sentry (or GlitchTip self-hosted) for web/extension/server exceptions, linked to trace IDs.
- **LLM quality:** eval results and sampled generations stored in Postgres and charted in Grafana; Langfuse optional if richer LLM tracing is wanted later.
- **Dashboards & alerts as code** in `ops/grafana/` and `ops/alerts/`, provisioned at startup. Every alert links to `docs/runbooks/<alert>.md`.

## Why
OTel avoids lock-in and is what the handoff engineer will most likely already know. LGTM runs locally for free, so observability exists from the first commit, not after launch.

## Consequences
- + One trace per application end-to-end; the in-app run inspector deep-links into it.
- − A few extra containers locally (acceptable; can be disabled with a compose profile).

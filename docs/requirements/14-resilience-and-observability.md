# 14 — Resilience, Fault Isolation & Observability

Product owner (2026-11-24): *"There are a lot of moving parts and I don't want the whole system to crash if one part faults. Observability must be integrated since I'll be the engineer this is handed off to once it ships."*

Design stance: **every subsystem can fail on its own, and the rest of the system keeps working and tells you what broke.** Decisions: ADR-0007 (fault isolation) and ADR-0008 (observability stack).

## 1. Fault isolation (bulkheads)

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| RES-001 | M | P1 | **Separate worker pools per domain.** Temporal task queues and worker processes are split: `sourcing`, `pipeline`, `apply-browser`, `inbox`, `outreach`, `calendar`, `profile`, `growth`, `llm`. A crash, memory leak or overload in one pool (e.g. Playwright browsers) cannot starve another. |
| RES-002 | M | P1 | **Per-dependency circuit breakers** (Claude API, Gmail, Calendar, GitHub, each ATS domain, each job source, contact providers). When open, dependent work waits in its workflow (durable) instead of failing, and the UI shows "Gmail paused: rate limited, retrying 14:05." |
| RES-003 | M | P1 | **Per-source / per-adapter isolation.** A broken job-source plugin or ATS adapter is quarantined automatically after N consecutive failures (status `degraded`). Other sources and adapters keep running. Jobs needing a quarantined adapter fall back to **assisted apply** (human handoff). |
| RES-004 | M | P1 | **Graceful degradation matrix** (below) is implemented and tested. The web app stays usable for reading and approving whenever Postgres and the API are up, even if every worker is down. |
| RES-005 | M | P1 | **Timeouts everywhere.** Every external call and every LLM call has a timeout and a retry policy with jittered backoff. No unbounded waits. Temporal activity heartbeats for long browser sessions. |
| RES-006 | M | P1 | **Idempotent side effects.** Every gateway call carries an idempotency key (`application:{id}:submit`, `email:{draftId}:send`). Retries after a crash never double-submit or double-send. |
| RES-007 | M | P1 | **Dead-letter + needs-human.** Work that exhausts retries goes to a dead-letter view with full context and one-click *retry / skip / hand off*. It is never silently dropped (complements OBS-004). |
| RES-008 | M | P1 | **Kill switches / feature flags per subsystem** (auto-apply, outreach send, inbox auto-labeling, each source, each adapter, each agent). Flip from the UI, effective in ≤ 10 s, logged in the activity feed. |
| RES-009 | M | P1 | **Backpressure and quotas.** Bounded concurrency per pool; per-day caps (applications, emails, LLM spend). When an LLM budget cap is hit, low-priority routes (nightly re-scoring) pause first and fresh-job routes keep running (freshness priority, SRC-013). |
| RES-010 | S | P2 | **LLM fallbacks.** Refusal / overload / timeout on a route → server-side fallback model or retry later. Deterministic code paths (dedupe, policy checks, provenance validation) never depend on an LLM being up. |
| RES-011 | M | P1 | **Data safety.** Daily Postgres backups with restore tested monthly; object storage versioning; migrations are backward-compatible (expand → migrate → contract). |
| RES-012 | S | P2 | **Chaos and fault-injection tests** in CI or staging: kill a worker pool, black-hole Gmail, return 429s from Claude, break an ATS page layout. Assert the degradation matrix holds. |
| RES-013 | M | P1 | **Health model.** Every subsystem reports `healthy / degraded / down` with a reason. Aggregated on a System Health page and as a status dot in the app header. |

### Graceful degradation matrix
| If this is down… | What still works | What the user sees |
|---|---|---|
| Claude API | Ingest, dedupe, approvals of already-built packages, submissions, pipeline, calendar | "Drafting paused: AI provider unavailable. 3 packages waiting." |
| Gmail | Everything except inbox triage, replies, outreach send | Inbox section badge: "Paused, reconnect or wait" |
| One ATS adapter | All other adapters; that ATS falls back to assisted apply | Jobs show "1-click handoff" instead of auto-submit |
| Playwright pool | Package building continues; submissions queue durably | "Submissions queued (12), browser workers restarting" |
| A job source | All other sources | Source marked degraded on System Health |
| Temporal | Web app read-only plus approvals recorded (signals replayed when it's back) | Banner: "Automation paused, nothing lost" |
| Postgres | Nothing (single point of truth). Mitigated by managed HA and backups | Maintenance page |

## 2. Observability (built in from day one, for the engineer who takes it over)

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| OBV-001 | M | P1 | **OpenTelemetry everywhere:** traces, metrics, logs from web, API, workers, gateways and the extension bridge. One trace follows a job from ingest → score → package → approval → submit → confirmation email (trace ID propagated through Temporal headers). |
| OBV-002 | M | P1 | **Structured JSON logs** with `trace_id`, `workflow_id`, `application_id`, `job_id`, `agent`, `route`. No secrets or full email bodies in logs (redaction middleware, tested). |
| OBV-003 | M | P1 | **LLM observability:** per call, the prompt version, model, effort, tokens in/out, cache hit tokens, latency, cost, stop reason, refusal category, and eval-scored samples. Viewable per route and per application. |
| OBV-004 | M | P1 | **Golden signals per subsystem** (rate, errors, latency, saturation) + **business SLIs:** freshness (posting → feed), time-to-apply, submission success rate per adapter, email-classification lag, approval queue age, LLM spend per day. |
| OBV-005 | M | P1 | **SLOs and alerts** for the SLIs above (e.g. freshness p95 ≤ 15 min for Tier-1; adapter success ≥ 95%; inbox lag ≤ 5 min). Alert routing: push notification + email; alert = actionable, linked to a runbook. |
| OBV-006 | M | P1 | **Dashboards as code** (provisioned with the stack): System Health, Pipeline Flow, Freshness, Adapters, LLM Cost & Quality, Inbox. |
| OBV-007 | M | P1 | **Runbooks** in `docs/runbooks/` for each alert and each subsystem: what it does, how it fails, how to diagnose, how to recover. Every alert links to one. |
| OBV-008 | M | P1 | **Synthetic probes:** daily dry-run of each ATS adapter against a test posting/form fixture; hourly freshness canary on a known-busy board; Gmail/Calendar token validity checks. |
| OBV-009 | S | P2 | **Error tracking** with release tagging (source maps for web/extension), linking errors to traces. |
| OBV-010 | M | P1 | **Handoff package:** `docs/operations.md` covers architecture recap, local setup, deploy, config & secrets, on-call checklist, common incidents, cost levers. Kept current as a definition-of-done item for every feature. |
| OBV-011 | S | P2 | **In-app run inspector ↔ trace link.** Every activity-feed item links to its trace in the observability backend (and the Temporal workflow history). |

## Acceptance criteria (selected)
- **RES-001/004:** Killing the `apply-browser` pool for 30 min: sourcing, scoring, packaging, inbox and approvals keep working. Submissions resume afterward with zero duplicates.
- **RES-003:** Injecting a layout change that breaks the Lever adapter quarantines it within 3 failures. Lever jobs show "1-click handoff". An alert fires with a runbook link.
- **OBV-001:** From any submitted application, one click opens a single trace that spans every step.
- **OBV-005:** Each alert in the catalog has a runbook and has fired at least once in a chaos test.

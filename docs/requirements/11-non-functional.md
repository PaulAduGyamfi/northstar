# 11 — Non-Functional Requirements

## Security & privacy
| ID | Pri | Requirement |
|---|---|---|
| NFR-SEC-001 | M | OAuth tokens and provider API keys encrypted at rest (envelope encryption, KMS or libsodium sealed box locally); never logged; never included in prompts. |
| NFR-SEC-002 | M | Least-privilege OAuth scopes; Gmail `send` capability isolated in a gateway that requires an approval record ID. |
| NFR-SEC-003 | M | No server-side storage of third-party site passwords (ATS accounts, LinkedIn). Authenticated browsing happens in the user's own browser via the extension. |
| NFR-SEC-004 | M | Prompt-injection defense: content from job postings, emails and web pages is treated as untrusted data; agents that read untrusted content cannot directly trigger send/submit tools — they produce proposals that pass the Approval Gate and policy checks. |
| NFR-SEC-005 | M | PII minimization: only job-related email is sent to an LLM; raw email bodies retained 90 days by default (configurable). Export & delete-all available. |
| NFR-SEC-006 | S | Audit log of every outbound action (who/what approved it, when, payload hash). |

## Compliance & platform terms
| ID | Pri | Requirement |
|---|---|---|
| NFR-TOS-001 | M | Each job source plugin declares access method and terms status (`official-api`, `public-feed`, `user-session-capture`, `prohibited`). `prohibited` sources cannot be enabled. |
| NFR-TOS-002 | M | No CAPTCHA solving, bot-detection evasion, or fingerprint spoofing (ADR-0003). |
| NFR-TOS-003 | M | Outbound email respects CAN-SPAM basics and daily caps. |

## Reliability
> Expanded in [14-resilience-and-observability.md](14-resilience-and-observability.md) (fault isolation, degradation matrix, SLOs, observability, handoff). The items below remain the baseline.

| ID | Pri | Requirement |
|---|---|---|
| NFR-REL-001 | M | Workflows are durable: a crash or deploy never loses an in-flight application or approval; resumed exactly once (idempotency keys on every external side effect). |
| NFR-REL-002 | M | External calls have timeouts, retries with backoff and circuit breakers per provider (ATS domain, Gmail, Claude API). |
| NFR-REL-003 | S | Adapter health checks: synthetic dry-run against each ATS adapter daily; breakage flips the adapter to "assisted only" and alerts. |

## Performance
| ID | Pri | Requirement |
|---|---|---|
| NFR-PRF-001 | M | Link ingest → job in feed ≤ 30 s p95. |
| NFR-PRF-002 | M | Event → UI feed ≤ 5 s p95. |
| NFR-PRF-003 | S | Package (tailored resume + answers) ready ≤ 3 min p95 after queueing. |

## Cost
> Estimates and levers: [cost-model.md](../cost-model.md).

| ID | Pri | Requirement |
|---|---|---|
| NFR-CST-001 | M | Per-feature LLM cost tracked (tokens, $) and shown in run inspector; monthly budget with soft/hard caps. |
| NFR-CST-002 | S | Prompt caching for stable prefixes (profile graph, voice guide, system prompts); batch API for non-urgent bulk work (nightly re-scoring). |

## Quality of AI output
| ID | Pri | Requirement |
|---|---|---|
| NFR-AIQ-001 | M | Each LLM feature has an eval set (golden inputs + graders) run in CI on prompt/model changes. |
| NFR-AIQ-002 | M | Provenance validation (no uncited claims) is a deterministic post-check, not just a prompt instruction. |
| NFR-AIQ-003 | S | Prompt and model versions recorded on every generated artifact. |

## Operability
| ID | Pri | Requirement |
|---|---|---|
| NFR-OPS-001 | M | Single `docker compose up` for local; one-command deploy for hosted. |
| NFR-OPS-002 | S | Structured logs + OpenTelemetry traces across API, workflows and agents. |

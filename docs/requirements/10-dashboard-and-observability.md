# 10 — Dashboard, Activity Feed & Approvals
Covers success criterion **S2** ("responsive, I know what's happening behind the scenes and the statuses of everything") and the dashboard half of **#6**.

## Requirements

### Activity feed (glass box)
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| OBS-001 | M | P1 | Every agent/worker action emits a domain event (`job.ingested`, `job.skipped`, `package.ready`, `application.submitted`, `email.classified`, `draft.created`, …) with actor, inputs summary, outputs, reason, and links. |
| OBS-002 | M | P1 | Live activity feed in plain sentences ("Tailored resume for Stripe — Backend Eng scored 91 and was queued for approval"), pushed to UI within 5 s (SSE/WebSocket). |
| OBS-003 | M | P1 | **Run inspector.** Any event can be expanded to see the workflow run: steps, timings, LLM calls (prompt version, model, tokens, cost), tool calls, retries, errors. |
| OBS-004 | M | P1 | Failures are never silent: every failed step becomes either an automatic retry (visible) or a `needs_human` item with a plain-English explanation. |
| OBS-005 | S | P2 | Notifications: push (PWA/mobile), email digest, optional Slack/Discord; per-event-type settings; quiet hours. |

### Approval queue
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| APR-001 | M | P1 | One queue for everything needing a human: application packages, new answers, email replies, outreach, profile fix PRs, weekly growth plan, prep plans. |
| APR-002 | M | P1 | Batch actions (approve all / approve selected), inline edit, reject with reason (reason feeds learning). |
| APR-003 | M | P1 | Approvals are mobile-friendly; a push notification can approve directly. |
| APR-004 | M | P1 | Approval records are immutable and referenced by the action they authorize (audit trail). |

### Pipeline dashboard
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| DSH-001 | M | P2 | Kanban + table of applications by status (03 state machine), filterable by company, score, source, date. |
| DSH-002 | M | P2 | Funnel metrics: discovered → applied → responded → screen → onsite → offer; conversion rates and time-in-stage. |
| DSH-003 | M | P2 | "Today" view: approvals waiting, needs-human items, upcoming interviews, follow-ups due, growth blocks today. |
| DSH-004 | S | P2 | Source/variant analytics: response rate by source, by score band, by resume variant, by time-to-apply after posting. |
| DSH-005 | S | P3 | Weekly report (email/artifact): what the system did, outcomes, what needs you. |
| DSH-006 | M | P2 | Application detail page: full timeline (ingest → package → approval → submission proof → emails → interviews), documents sent, answers used. |

## Acceptance criteria (selected)
- **OBS-002:** Killing a worker mid-submission shows a visible retry or `needs_human` within 60 s — not a stuck "submitting" status.
- **DSH-003:** The "Today" view answers "what do I need to do right now?" with zero navigation.

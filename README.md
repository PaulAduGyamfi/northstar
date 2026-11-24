# Northstar — the agentic job search toolkit

> Working name. Rename freely (see `docs/open-questions.md` Q-01).

One system that **finds jobs, applies to them, runs your inbox, and keeps your public profiles sharp** — so the human spends their time on skills, interviews and relationships instead of form-filling.

## The one-line contract

> Applying is hands-free (≤ 1 click). Every agent action is visible. Nothing leaves my name without my approval unless I said it could. My skills grow on a schedule, not on leftover energy.

## Repo map

| Path | What lives there |
|---|---|
| [docs/00-vision.md](docs/00-vision.md) | Problem, success metrics, principles, scope by phase |
| [docs/requirements/](docs/requirements/) | Capability requirements with IDs, priorities and acceptance criteria |
| [docs/architecture/system-design.md](docs/architecture/system-design.md) | Components, data model, workflows, sequence diagrams |
| [docs/architecture/system-architecture.svg](docs/architecture/system-architecture.svg) | The one-picture view of the system |
| [docs/adr/](docs/adr/) | Architecture Decision Records — the *why* behind the design |
| [docs/differentiators.md](docs/differentiators.md) | Where we beat ApplyASAP & co. — up for discussion |
| [docs/open-questions.md](docs/open-questions.md) | Decisions the product owner still has to make |
| [docs/roadmap.md](docs/roadmap.md) | Phased delivery plan |
| [docs/cost-model.md](docs/cost-model.md) | Estimated monthly running cost and cost levers |
| [AGENTS.md](AGENTS.md) | Rules for any coding agent working in this repo |
| [CLAUDE.md](CLAUDE.md) | Claude Code notes (imports AGENTS.md) |
| [.claude/](.claude/) | Agent harness: settings, hooks (`bash .claude/hooks/test-hooks.sh`), reviewer subagents, `/ticket` `/verify` `/adr` skills, path rules |
| [specs/](specs/) | Ticket specs (`NS-NNN`) and templates |

## Requirement index (user's numbered asks → docs)

| # | Ask | Requirement doc |
|---|---|---|
| 1 | Auto apply based on resume | [03-auto-apply](docs/requirements/03-auto-apply.md) |
| 2 | Human-sounding answers, reuse repeated answers | [03-auto-apply](docs/requirements/03-auto-apply.md), [04-answer-bank-and-voice](docs/requirements/04-answer-bank-and-voice.md) |
| 3 | Fix + tailor resume per role | [02-matching-and-tailoring](docs/requirements/02-matching-and-tailoring.md) |
| 4 | Draft replies to follow-ups (approval required) | [05-inbox-and-pipeline](docs/requirements/05-inbox-and-pipeline.md) |
| 5 | Paste any JD link → ingest → apply | [01-job-sourcing](docs/requirements/01-job-sourcing.md) |
| 6 | Email categorization → pipeline dashboard | [05-inbox-and-pipeline](docs/requirements/05-inbox-and-pipeline.md), [10-dashboard-and-observability](docs/requirements/10-dashboard-and-observability.md) |
| 7 | Short-answer drafting in my voice, saved for reuse | [04-answer-bank-and-voice](docs/requirements/04-answer-bank-and-voice.md) |
| 8 | Web-wide job sourcing (ApplyASAP-style) | [01-job-sourcing](docs/requirements/01-job-sourcing.md) |
| 9 | Cold email: find people + draft (approval required) | [06-outreach](docs/requirements/06-outreach.md) |
| 10 | Profile scanner: GitHub, LinkedIn, website | [07-profile-optimization](docs/requirements/07-profile-optimization.md) |
| 11 | Inbound recruiter email grading | [05-inbox-and-pipeline](docs/requirements/05-inbox-and-pipeline.md) |
| 12 | Calendar: interviews, reminders, scheduled prep | [08-interviews-and-calendar](docs/requirements/08-interviews-and-calendar.md) |
| 13 | Current profile grade | [07-profile-optimization](docs/requirements/07-profile-optimization.md) |
| 14 | Every possible profile for visibility | [07-profile-optimization](docs/requirements/07-profile-optimization.md) |
| 15 | Project / skill growth tracker with balancing | [09-growth-tracker](docs/requirements/09-growth-tracker.md) |
| — | "I know what's happening behind the scenes" | [10-dashboard-and-observability](docs/requirements/10-dashboard-and-observability.md) |
| — | Security, privacy, ToS, cost, reliability | [11-non-functional](docs/requirements/11-non-functional.md) |
| — | Easy, not-boring UI; approve mockups before build | [12-ui-ux](docs/requirements/12-ui-ux.md), [docs/design/](docs/design/) |
| — | "Why no offer after 9 months?" — funnel diagnosis | [13-search-diagnostics](docs/requirements/13-search-diagnostics.md) |
| — | No single fault crashes the system; observability for handoff | [14-resilience-and-observability](docs/requirements/14-resilience-and-observability.md) |
| — | Newly posted jobs first; preferences editable any time | [01-job-sourcing](docs/requirements/01-job-sourcing.md) (SRC-012…018) |

## Status

Phase 0 — requirements and architecture. No application code yet. **Build is gated on the product owner approving a UI direction** (UX-000) — mockups in [docs/design/mockups/](docs/design/mockups/).

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
| [apps/api/](apps/api/) | The local API the web app and extension talk to (127.0.0.1, Paul's sign-in and passkeys) |
| [apps/web/](apps/web/) | The web app: Today, Queue, Pipeline, Inbox, Grow, Jobs, Interviews, Career DNA, Health, Settings |
| [apps/extension/](apps/extension/) | "Save to Northstar" Chrome extension: save a job page, pre-fill a handed-off form |
| [apps/worker/](apps/worker/) | The worker process: Temporal workflows (submission, the stale-claim sweep, the decision relay) and their pools |
| [packages/domain/](packages/domain/) | Pure rules: application states, approval policy, growth planner, interview prep, metrics |
| [packages/db/](packages/db/) | Postgres schema, migrations and the append-only write paths |
| [packages/llm/](packages/llm/) · [packages/prompts/](packages/prompts/) | The only LLM gateway, and versioned, hash-locked prompts |
| [packages/sources/](packages/sources/) | Adding jobs from links, board polling (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday), fit scores, posting liveness, fresh-job alerts |
| [packages/profile/](packages/profile/) | Resume import, stories, tailoring, audit, answers, replies, voice, Career DNA |
| [packages/inbox/](packages/inbox/) | Read-only Gmail and Calendar, mail linking, verification codes, interview detection |
| [packages/pipeline/](packages/pipeline/) | Assembling an application package for the Approval Gate |
| [packages/gateways/](packages/gateways/) | The only code that acts outward: Apply Gateway, browser form driver, Gmail drafts, approved prep blocks on a Northstar calendar (`funnel prep`), vault |
| [packages/funnel/](packages/funnel/) | The 9-month backfill and funnel report, and the one-shot calendar interview check (`funnel interviews`), job-mail check (`funnel inbox`), interview prep (`funnel prep`) and approved replies to Gmail drafts (`funnel drafts`) |
| [evals/](evals/) | Eval sets per LLM route, replayed in CI |

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
| — | Effortless account-wall sites (Workday) and email verification codes | [15-accounts-and-verification](docs/requirements/15-accounts-and-verification.md), ADR-0010 |
| — | Work tracking | GitHub Issues (`NS-NNN`), seeded from [docs/backlog.md](docs/backlog.md) |

## Status

Phase 1 is being built ticket by ticket from the GitHub issues, mostly by agents working under
ADR-0016 (the autonomous lane, see [docs/adr/](docs/adr/)). The building blocks exist and are
tested on synthetic data, but **nothing runs on a schedule yet**. The worker process exists
(`pnpm --filter @northstar/worker start`, NS-225), runs the stale-claim sweep and the relay that passes your approval decisions to waiting
submissions, and shows each pool
on the Health page (a stopped pool reads "Not running"), but nothing
starts submission workflows yet, so no application is submitted and no mail is polled
automatically. Its browser pool
is off unless you turn it on (`WORKER_APPLY_BROWSER=on`); while it is off, a submission waits in
Temporal's queue (it isn't dropped) and still needs your approval when the pool comes on. Interviews on your calendar are found when you run `pnpm --filter @northstar/funnel funnel
interviews` (Google consent each run, no stored token) and wait for you on the Interviews page;
detection doesn't run on its own yet. New job mail is linked to your applications and sorted when
you run `pnpm --filter @northstar/funnel funnel inbox` (Gmail consent each run, no stored token);
it shows on the Inbox page. Recruiter emails are graded A–F (nudged by what your regrades taught
it, at most two points) in the same run once you turn on
`RECRUITER_EXTRACT` (off by default). With `RECRUITER_REPLIES` on (off by default), the same run
also drafts a short reply to each graded recruiter email you haven't answered (interested,
asking for more, or a polite no; nothing for an F) and puts it in your Queue: nothing is sent.
Replies you approve in the Queue go into your Gmail drafts when you run
`pnpm --filter @northstar/funnel funnel drafts` (Google consent for Gmail drafts only, each run,
no stored token); it never sends, so you read and send each one from Gmail yourself.
Prep for the interviews you confirmed is planned and sent to
your Queue when you run `pnpm --filter @northstar/funnel funnel prep`; the next run adds the plans
you approved to a Northstar calendar it creates (Google consent for that calendar only, each run,
no stored token). The plan's blocks print in your terminal on the run that files it, and "Show the
plan" on its Queue card lists them before you approve. It plans
around your other interviews and their prep, and with `funnel prep --busy-from-calendar` around
the other timed meetings on your calendar too (a second, read-only Google consent that run;
all-day events such as a day off aren't counted yet). Once you make a VAPID key pair (the one-line
command in `.env.example`, no account anywhere) and turn on notifications from Today, the worker
pushes each new "Needs your hands" item, each request newly waiting in your Queue (filed in the last day; up to five
alone at a time, then one "N more waiting" notification), and each fresh-job alert from the last
hour (never one held for quiet hours), to your browsers once, in fixed words with no link, company
or job title; tapping it opens Today, or the Queue with that request marked. A notification never
approves anything. The `push` switch on the Health page stops it. What each package does today is listed
under "Layout" in [AGENTS.md](AGENTS.md).

## Getting started (local)

```bash
nvm use && corepack enable pnpm            # Node 24, pnpm from package.json
pnpm install --frozen-lockfile
pnpm turbo run lint typecheck test build   # what CI runs
```

Running the stack, migrations and the apps needs the settings files described in
[AGENTS.md](AGENTS.md)'s Commands table: the owner's file for compose and `db:migrate`, and the
apps' own file (NS-235). Every command, and who may run it, is listed there.

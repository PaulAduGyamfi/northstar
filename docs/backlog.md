# Backlog seed → GitHub Issues

Source for creating the issues (NS-101 step 8). Once created, **GitHub Issues is the source of
truth** and this file is only the history of the first cut. Each issue title is `NS-NNN: <title>`,
and its body links the requirement IDs and says what "done" looks like.

## Labels
`area:sourcing` `area:apply` `area:accounts` `area:answers` `area:inbox` `area:outreach`
`area:profiles` `area:interviews` `area:growth` `area:diagnostics` `area:ui` `area:platform`
`area:llm` `area:observability` · `type:feature` `type:infra` `type:docs` `type:spike` ·
`priority:p0` `priority:p1` `priority:p2`

## Milestones
`P0 Foundations` · `P1 Core loop` · `P2 Inbox, interviews, growth` · `P3 Reach` · `P4 Compounding`

## P0 Foundations
| Ticket | Title | Requirements | Labels |
|---|---|---|---|
| NS-101 | Repository guardrails: CI, branch protection, commit checks, license, data guards | ADR-0011 | platform, infra, p0 |
| NS-102 | Account-wall and email-verification requirements (ADR-0010) | ACC, VER, CRD | accounts, docs, p0 |
| NS-103 | Monorepo scaffold: Node 24, pnpm 10, Turborepo, Biome, Vitest, CI build steps | ADR-0005, ADR-0011 | platform, infra, p0 |
| NS-104 | Local stack: docker compose (Postgres+pgvector, Temporal, MinIO, Grafana LGTM, OTel Collector) | NFR-OPS-001, ADR-0008 | platform, observability, p0 |
| NS-105 | Domain + db packages: entities, state machine, event outbox, migrations | 03 states, OBS-001 | platform, p0 |
| NS-106 | LLM gateway + eval harness (structured outputs, caching, metering, recorded fixtures) | ADR-0006, NFR-AIQ, OBV-003 | llm, p0 |
| NS-107 | Clickable B · Momentum prototypes for UX-002 (Queue stack + compact, Pipeline, Growth, Diagnostics, Settings) | UX-000…047 | ui, p0 |

## P1 Core loop
| Ticket | Title | Requirements | Labels |
|---|---|---|---|
| NS-110 | Candidate profile graph: resume/LinkedIn/GitHub import into experience atoms | CPG-001…004 | answers, p1 |
| NS-111 | Guided story interview → STAR story bank | CPG-003 | answers, p1 |
| NS-112 | Employment-facts consistency (official HR dates everywhere) | DX-011 | diagnostics, p1 |
| NS-113 | Gmail connect + 9-month funnel backfill + funnel report | INB-001/002, DX-001…005 | inbox, diagnostics, p1 |
| NS-114 | Link ingest + extension capture | SRC-001/002/006 | sourcing, p1 |
| NS-115 | ATS board polling with freshness SLOs and fresh-first queue | SRC-003/009/012…015 | sourcing, p1 |
| NS-116 | Fit scoring with evidence, live preferences | MAT-001…003, SRC-017 | sourcing, llm, p1 |
| NS-117 | Resume tailoring with provenance validator + diff + pre-send score | TLR-001…005, ADR-0004 | apply, llm, p1 |
| NS-118 | Answer bank, canonical questions, voice profile | ANS-001…008 | answers, llm, p1 |
| NS-119 | Approval Gate, policies, batch approve, undo window | APR-*, ADR-0002 | apply, p1 |
| NS-120 | Apply Gateway: Greenhouse, Lever, Ashby adapters + proof of submission | APPLY-001/002/007…009 | apply, p1 |
| NS-121 | Human handoff via extension (CAPTCHA, login, SMS) | APPLY-006, ACC-007 | apply, p1 |
| NS-122 | Credential vault + password-manager mirror | CRD-001…005, ADR-0010 | accounts, p1 |
| NS-123 | Verification Catcher (email codes and magic links) | VER-001…006 | accounts, inbox, p1 |
| NS-124 | Tenant registry + Workday account creation, sign-in and adapter | ACC-001…008 | accounts, apply, p1 |
| NS-125 | Activity feed (agent crew), run inspector, health model, kill switches | OBS-*, RES-008/013 | observability, ui, p1 |
| NS-126 | Resilience: bulkhead queues, breakers, quarantine, dead-letter | RES-001…009, ADR-0007 | platform, p1 |
| NS-127 | Positioning thesis + gap-to-proof narrative | DX-009/010 | diagnostics, p1 |

P2–P4 issues are cut when P1 is half done, from `docs/roadmap.md`.

## Eval sets (product owner, 2026-11-24: "labeling is your job")
Agents build every eval set. Synthetic cases cover the edges. Real cases (e.g. Paul's past job
emails) are labeled by two independent model passes, and **Paul only sees the cases where the two
disagree**. Real-mail evals live in `evals/**/private/` (gitignored); only synthetic sets are
committed.

## Ideas (idea dump)
Paul's ideas, turned into requirements and issues as they come in. The issue is the source of truth.
These issues are cut when the idea arrives, an exception to "P2–P4 issues are cut when P1 is half done".

| Ticket | Title | Requirements | Labels |
|---|---|---|---|
| NS-130 | Career DNA: evidence-based career report and approved share card | DNA-001…008 | profiles, feature, p2 |
| NS-131 | Spike: free public Career DNA launch (multi-tenant, privacy, cost) | DNA-009/010, Q-02 | profiles, spike, p2 |

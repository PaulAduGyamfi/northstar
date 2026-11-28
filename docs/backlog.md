# Backlog seed → GitHub Issues

Source for creating the issues (NS-101 step 8). Once created, **GitHub Issues is the source of
truth** and this file is only the history of the cuts. Each issue title is `NS-NNN: <title>` with
its own number (ADR-0016 item 15), and its body links the requirement IDs and says what "done"
looks like. Agents work them in NS-number order, skipping blocked ones (ADR-0016 item 12).

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

## Renumbered follow-ups (2026-11-25)
The first parallel agent run filed follow-ups titled after their parent ("NS-123 follow-up: …"),
so many titles started alike. Each now has its own number, in the order the issues were opened;
the parent stays in the body (`Parent: #N`).

| Ticket | Issue | Title | Notes |
|---|---|---|---|
| NS-132 | #39 | Harness: tokenize gh and git push detection like the NS-109 docker guard | needs:paul (`.claude/` hooks) |
| NS-133 | #42 | Profile: import LinkedIn export, GitHub repos and personal site | |
| NS-134 | #43 | Profile: handle two-column PDF resumes | |
| NS-135 | #60 | Answer-draft route that cites stories and atoms | |
| NS-136 | #61 | Voice profile from writing samples and learning from edits | |
| NS-137 | #62 | Embeddings and model confirm for canonical-question matching | needs:paul |
| NS-138 | #65 | Model-assisted requirement matching for the Fit Score | |
| NS-139 | #68 | Approval queue surfaces (inline edit, mobile and push approve) | blocked by NS-156 |
| NS-140 | #69 | Gate hardening (withdraw record, derived policy facts, non-owner DB role, workflow signals) | |
| NS-141 | #71 | Answer factual questions from profile settings | |
| NS-142 | #76 | Playwright form driver and recorded Greenhouse, Lever, Ashby fixtures | needs:paul |
| NS-143 | #78 | Surface stale apply claims and take pacing limits from config | |
| NS-144 | #83 | Resume-tailor model route for the summary and job-term wording | |
| NS-145 | #84 | Render tailored resumes to PDF and DOCX and re-parse the PDF | |
| NS-146 | #85 | Store tailored resumes per application and add a tailor command | |
| NS-147 | #87 | Wire breakers and kill switches into callers, dead-letter, quotas | #98 closed as its duplicate |
| NS-148 | #89 | Gmail push and the Northstar/Verification label for the Verification Catcher | needs:paul |
| NS-149 | #90 | LLM extraction fallback for verification mail | |
| NS-150 | #91 | Keep verification mail out of the funnel backfill | |
| NS-151 | #92 | Persist verification windows with the gateway session | blocked by NS-124 |
| NS-152 | #95 | Guided thesis session, CLI, and gap-to-proof narrative | blocked by NS-155 |
| NS-153 | #99 | System Health page, live activity feed and kill-switch toggles in the app | blocked by NS-156 |
| NS-154 | #100 | Run inspector (steps, timings, LLM calls, retries) | blocked by NS-157, NS-156 |
| NS-155 | #103 | Store Paul's approved positioning thesis versions | carries #96's rules line |

Closed without a number: #77 and #88 (their `.claude/rules` lines are in), #96 (its rules line
ships with NS-155, since the thesis tables arrive there), #98 (duplicate of #87).

## P1 gaps (cut 2026-11-25)
P1 items on the roadmap that had no issue.

| Ticket | Title | Requirements | Labels |
|---|---|---|---|
| NS-156 | Web app and API scaffold with Paul's sign-in | UX-*, APR-001, NFR-SEC-*, ADR-0005, ADR-0009 | ui, platform, p1 |
| NS-157 | Temporal worker pools | RES-001, ADR-0001, ADR-0007 | platform, p1 |
| NS-158 | Link job mail to applications: tagged address, deterministic matching, origin | INB-004 (link), INB-007, INB-009…012, VER-007 (INB-008 labels in NS-164) | inbox, p1 |
| NS-159 | Resume audit with line-level suggestions | AUD-001/002 | profiles, p1 |
| NS-160 | Review leftovers: sender and header hardening, apply feed lines, stale comment | VER-002, OBS-002, RES-008 | inbox, observability, p1 |
| NS-161 | Application package assembly | APPLY-001 | apply, p1 |
| NS-162 | Generic adapter for unknown application forms (blocked by NS-142) | APPLY-003 | apply, llm, p1 |
| NS-163 | Fresh-job alerts (blocked by NS-156) | SRC-015 | sourcing, p1 |

Cut earlier from NS-114 and not listed above: NS-128 (#51, extension capture, SRC-002, blocked by
NS-156) and NS-129 (#52, embedding-based dedupe, SRC-006, needs a provider choice).

## P2 — Inbox, pipeline, interviews, growth (cut 2026-11-25)
From `docs/roadmap.md` P2, cut now that P1 is past half done.

| Ticket | Title | Requirements | Labels |
|---|---|---|---|
| NS-164 | Gmail triage: classify job mail, type and origin labels, status from email | INB-003, INB-004 (status), INB-005, INB-008 | inbox, p2, needs:paul |
| NS-165 | Unified job inbox view | INB-006 | inbox, ui, p2 |
| NS-166 | Reply drafts and follow-up nudges | RPL-001…004 | inbox, p2, needs:paul |
| NS-167 | Recruiter grading of inbound messages | REC-001…003 | inbox, p2 |
| NS-168 | Pipeline dashboard, Today view and application timeline | DSH-001…004, DSH-006 | ui, p2 |
| NS-169 | Google Calendar connect and interview detection | CAL-001, CAL-002 | interviews, p2, needs:paul |
| NS-170 | Interview prep: blocks, reminders, briefs, practice and review | CAL-003…007 | interviews, p2 |
| NS-171 | Growth tracker: tracks, milestones, weekly capacity, balance rules | GRW-001…004 | growth, p2 |
| NS-172 | Growth progress capture, dashboard and weekly review | GRW-005…007 | growth, p2 |
| NS-173 | SmartRecruiters apply adapter and posting liveness checks | APPLY-002, SRC-010 | apply, sourcing, p2 |

## Closed without a closing PR (2026-11-27, 2026-11-28)

These issues were finished by work that didn't close them. The PR that added each row closed it on merge.

| Issue | Done by |
|---|---|
| #136 NS-180 | the hook self-test uses a top-level name that never exists (`.claude/hooks/test-hooks.sh`, merged with NS-156's follow-ups) |
| #182 NS-205 | ADR-0023, Accepted: package assembly lives in `packages/pipeline` |
| #200 NS-215 | #262 (the dead-letter view) and its producer NS-220 |
| #219 NS-221 | ADR-0024, Accepted: the reveal goes through the Gate and the API with a passkey |
| #261 NS-236 | #344 (dead-letter kinds on a fixed list) |
| #363 NS-258 | #365 and #373 (per-test and package-level timeouts) |
| #263 NS-237 | slices 1–6: filing with the Gate, the Queue view and edits, nudges, the Gmail draft writer with its consent flow and stored ledger; every "done when" item is met |
| #290 NS-246 | slices 1–2: the Reveal button on Settings → Accounts and the reveal's database guards; the optional focus and shared-constant polish is not needed, and the 30 s clear stays |
| #257 NS-235 | NS-235's own PR: the owner's credentials stay in the root file compose and `db:migrate` load, the apps load `.env.app`, and `loadDbConfig` refuses to start while either credential is in their environment |
| #293 NS-247 | slices 1–2 (`pollNewMail`, spam and trash skipped, the stored cursor and `pollFromCursor`), NS-252 (#313) for company domains, and `funnel inbox` (#413) as the poller's caller |
| #313 NS-252 | Paul chose his own input per company: append-only `company_domain` and `jobs domains`, fed into `readLinkCandidates` and the pre-filter's `knownDomains` |
| #271 NS-240 | slices 1–6: the read-only Calendar client, stored detections and Paul's decisions, the consent flow, `runInterviewDetection`, the `/interviews` confirm page, and `funnel interviews` as its caller; a scheduled run was declined on #400 |
| #400 NS-270 | Paul decided per-run consent: no stored Google refresh token and no scheduled detection; ADR-0014 and ADR-0026 stand |
| #172 NS-197 (built as NS-199) | #326 (alert candidates narrowed to recent jobs and held alerts), #334 and #355 (quiet hours, zone and the tier-1 rule as in-app settings), #451 and #453 (each `job.fresh_alert` pushed at most once) |
| #195 NS-213 | #299 (the Gate derives package policy facts) and #406 (the relay signals waiting submission workflows); its facts follow-up #297 was done in #414, #419 and #420 (closed by #422). Checking the worker client's not-found errors against a real Temporal belongs with #229 |
| #429 NS-275 | decided on the issue: option 2, known words only, built in #443 (NS-277) and tightened in #450 (NS-278) |

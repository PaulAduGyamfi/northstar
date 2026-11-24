# Differentiators — where we can stand out

Benchmark: ApplyASAP (applyasap.now) — human team applies for you, tailored resume per job with a match score, plain-English activity log, read-only Gmail reply detection on its top tier, monthly caps. It doesn't name its sources, has no stated speed, no voice learning, no outreach, no profile work, no skill growth.

**Status: all of D-01 … D-12 ACCEPTED by the product owner (2026-11-24).** D-01 (freshness) is elevated to the top sourcing priority. New items D-13+ come from the search-diagnostics work and are proposed below the table.

| ID | Idea | Why it's different | Builds on |
|---|---|---|---|
| D-01 | **First-hour applicant.** Poll ATS boards of a curated watchlist every 15–30 min; dream-company postings get a ready package + push within minutes. Show "applied 23 min after posting" on each application. | Competitors don't define freshness. Early applicants get disproportionate recruiter attention. | SRC-003, APPLY-013 |
| D-02 | **Glass-box agents.** Every action in plain English, click through to the exact inputs, prompts, evidence and cost. | Others show *what* happened; we show *why*, and you can correct the why. | OBS-001..004 |
| D-03 | **Provenance on every line.** Click any resume bullet or answer → the real experience it came from. Uncited claims are impossible. | Turns "AI-written" into "my stories, well told." Also doubles as interview prep — you can defend every line. | ADR-0004 |
| D-04 | **Voice that learns.** Measured style profile + learning from every edit; the 20th answer needs fewer edits than the 1st. Show an "edit distance trend" chart as proof. | No competitor learns your writing. | ANS-007/008 |
| D-05 | **Market → skills loop.** Unmatched requirements across hundreds of target JDs and interview weak spots re-weight your growth plan ("AWS appears in 38% of target roles; SAA stays in focus"). | Nobody connects the job search to what you should learn next. This is the bridge between your two halves of the app. | MAT-005, GRW-008 |
| D-06 | **Proof-of-work flywheel.** Finished milestones (SAA pass, Backpocket release, FDE pathway module) auto-draft resume atoms, README updates and LinkedIn posts → profile grade ↑ → inbound ↑. | Skill growth becomes visibility automatically. | GRW-009, GRD-003 |
| D-07 | **Warm-path finder.** Before cold email, check your LinkedIn connections export for ex-Mastercard colleagues / alumni at the target company and draft a referral ask. | Referrals convert far better than cold applies; most tools ignore your network. | OUT-003 |
| D-08 | **Outcome analytics on your own funnel.** Response rate by resume variant, answer variant, source, time-to-apply, score band. The system recommends what to change. | Turns your search into an experiment you can learn from. | DSH-004, ANS-011 |
| D-09 | **Recruiter inbound concierge.** Grade + reply drafts so A-grade recruiters get a response within an hour, D-grade get a polite no. | Being fast with good recruiters compounds S5. | REC-* |
| D-10 | **Interview autopilot.** Booking an interview auto-schedules prep blocks, generates a brief mapped to your stories, runs a mock, reminds you, and drafts the thank-you. | End-to-end, not just a calendar event. | CAL-* |
| D-11 | **Trust dial.** Per-rule autonomy (auto-submit only when Fit ≥ 85, known ATS, all answers reused). Start fully supervised and turn the dial as trust grows. | Autonomy you can reason about, instead of all-or-nothing. | ADR-0002 |
| D-12 | **FDE-portfolio angle (meta).** This repo itself — durable agent workflows, approval gates, evals, provenance — is a flagship portfolio piece for AI/FDE roles. Build it in public. | Your job-search tool becomes your best project for the jobs you want. | Growth tracker |

## Proposed additions (from the 9-month diagnosis — see requirements/13-search-diagnostics.md)

| ID | Idea | Why it's different |
|---|---|---|
| D-13 | **Funnel doctor.** The app tells you *which stage* is leaking (not getting callbacks vs. failing screens vs. failing onsites) and prescribes the fix for that stage, with evidence. | Every other tool optimizes volume. Volume doesn't fix a leak at stage 3. |
| D-14 | **Recruiter-eye simulation.** Before a resume variant goes live, simulated 6-second screens by role-specific "recruiter personas" (fintech in-house, startup founder, agency) score it; real response data then calibrates the simulator. | Feedback in minutes instead of 6 weeks of silence. |
| D-15 | **Gap-to-proof narrative.** Turns the time since Mastercard into a visible proof-of-work story (SAA, FDE pathway, Backpocket, Scripture Challenge) on the resume, LinkedIn and in screen answers. | Converts the most common silent rejection reason into a strength. |
| D-16 | **Channel mix coach.** Tracks effort and outcomes by channel (cold apply, referral, outreach, recruiter inbound) and pushes the mix toward what converts for you. | Cold-apply-only searches stall; this makes that visible. |
| D-17 | **Unfair-advantage targeting.** Ranks companies where 4 years at Mastercard is a moat (payments, fintech infra, card issuing, fraud/risk, high-scale regulated systems, banks modernizing) and where FDE/AI skills are scarce. | Stops competing as a generic SWE; competes where your background wins. |

## Recommendation
Prioritize **D-03, D-05, D-11, D-13** in P1/P2 design (they shape the architecture and are hard to retrofit). D-01 and D-02 come almost free from the architecture.

# 13 — Search Diagnostics ("why haven't I landed anything?")

## Context (from product owner, 2026-11-24)
- 4 years as a software engineer at Mastercard. Laid off **February 2026**; official separation date on paper **April 2026**.
- Searching for ~9 months with no offer. People have said the resume is strong.

"Strong resume, no offers after 9 months" is a symptom, not a diagnosis. An FDE treats this like a production incident: **find where in the funnel it breaks, with data, before prescribing fixes.** A resume tweak can't fix a problem at the onsite stage, and interview prep can't fix a problem at the ATS filter.

## The funnel and where it can leak

```
Applications ─► Any human response ─► Recruiter screen ─► Technical rounds ─► Onsite/final ─► Offer
     (A)               (B)                   (C)                (D)               (E)
```

| Leak at | What it looks like | Likely causes (hypotheses) | How the system tests it |
|---|---|---|---|
| **A → B** (silence or fast auto-rejections) | < ~3% response from cold applies; rejections arriving within hours | **H1 Timing:** applying days after posting, buried under hundreds of applicants · **H2 ATS/keywords:** resume doesn't parse cleanly or misses the JD's terms · **H3 Targeting/level:** wrong level, stack, or domain for the roles · **H5 Gap signal:** months since last role with nothing visible in between · **H6 Channel:** almost all cold applies, no referrals · **H10 Constraints:** location/remote/work-auth filters | Time-to-apply vs. response (SRC-014) · parse + keyword check (TLR-004) · **rejection latency** (a rejection within ~24 h usually means an automated or knockout filter, not a human read) · response rate by fit band and level · gap-narrative variant test · response rate by channel |
| **B → C** (recruiter talks but it stops) | Responses but few screens, or screens that don't advance | **H4 Positioning:** "big-company enterprise engineer" read as slow or legacy by startups · comp expectation mismatch · location · unclear story about the layoff/gap · **H11 Inconsistency:** LinkedIn ≠ resume (titles, dates) | Screen notes and outcomes (CAL-007) · pitch rehearsal scoring · comp band vs. posted ranges · consistency check (PRF-004, DX-011) |
| **C → D/E** (screens OK, technical rounds fail) | Passing screens, failing coding/system design | **H8 Interview performance:** rusty LeetCode-style coding, system design depth, behavioral stories without metrics | Per-round reviews, question bank, mock-interview scores, weak areas → growth plan |
| **E → Offer** (finals but no offers) | Getting to finals, losing at the end | Close-call competition, leveling, reference/background issues, team-match timing | Final-round debriefs, ask for feedback drafts, level analysis |

Also **H9 Market:** the 2026 market for mid-level generalist SWE roles is crowded, and AI-assisted applicants add volume. Mitigation is differentiation (D-17), not just more volume.

## A specific risk to check right away: employment dates
Separation was **February 2026** in practice and **April 2026** on paper (likely notice period or severance). Background checks and employment verification services report the **official HR dates**. If the resume says one end date, LinkedIn says another, and verification says a third, that inconsistency can quietly kill offers late in the process.
→ **DX-011:** Pick the date your employer's records show (confirm with HR or your separation paperwork) and use it **everywhere**. Tell the story the same way everywhere: "role eliminated in a reduction in force." Being laid off is common and carries little stigma. Inconsistency does.

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| DX-001 | M | P1 | **Funnel backfill from email.** With Gmail connected, scan mail since **2026-02-01** for application confirmations, rejections, recruiter messages and interview invites. Reconstruct the past 9 months of applications into the pipeline (company, role, date, outcome, stage reached, rejection latency). The user confirms ambiguous matches in a review queue. **This is the first thing the app does after onboarding.** |
| DX-002 | M | P1 | **Manual history import.** Import any spreadsheet or tracker the user kept (CSV/Sheets). Merge and dedupe with DX-001. |
| DX-003 | M | P1 | **Funnel report.** Conversion at each stage (A–E), compared against configurable *assumed baselines* (shown as assumptions, recalibrated as the user's own data grows). Flags the **leakiest stage** with confidence and sample size. |
| DX-004 | M | P1 | **Hypothesis board.** Each hypothesis H1–H11 has a status (*supported / weakened / untested*), the evidence behind it, and the next test. Updated automatically as data arrives. Plain-language summary at the top: "Most likely problem: X. Here's why. Here's what we're doing about it." |
| DX-005 | M | P1 | **Rejection-latency analysis.** Time from application to rejection, bucketed (< 24 h, 1–7 d, > 7 d, never). A high share of fast rejections points to knockout questions or ATS filters, and the system inspects which form answers (sponsorship, years of X, location, salary) were in common. |
| DX-006 | M | P2 | **Controlled experiments.** A/B testing of resume variants, positioning headlines, and channel mix, with randomized assignment per comparable job and minimum sample sizes. Results say "not enough data yet" until they're meaningful. |
| DX-007 | S | P2 | **Recruiter-eye simulation (D-14).** Persona-based simulated screens of each resume variant ("fintech in-house recruiter," "seed-stage founder," "agency recruiter"): 6-second takeaway, perceived level, top concerns. Calibrated against real response data over time. |
| DX-008 | S | P2 | **Human review loop.** Export an anonymized resume and a short review form to send to trusted reviewers (ex-colleagues, mentors, recruiters you know). Collect structured feedback in the app and attach it to hypotheses. |
| DX-009 | M | P1 | **Positioning thesis.** A guided session produces a one-sentence candidate thesis (e.g. *"Backend engineer from 4 years of payments scale at Mastercard who now builds production AI agents"*), and that thesis drives resume summary, LinkedIn headline, screen pitch and outreach. The thesis is versioned and A/B testable (DX-006). |
| DX-010 | M | P1 | **Gap-to-proof narrative (D-15).** Show the months since Mastercard as proof of work: AWS SAA progress, Anthropic FDE pathway, Backpocket, Scripture Challenge hardening. Generates resume and LinkedIn entries (e.g. a "Projects / Independent work 2026" section) and a 20-second spoken answer for "what have you been doing since?" Uses the provenance rules (ADR-0004). |
| DX-011 | M | P1 | **Employment-facts consistency.** A single source of truth for employer, title(s), and start/end dates (official HR dates). Checked against resume, LinkedIn, site and every application form. Any mismatch is a red item on the Today view. |
| DX-012 | M | P1 | **Unfair-advantage targeting (D-17).** Company tiering boosts companies where Mastercard experience is a moat (payments, card issuing, fintech infra, fraud/risk, banks and networks modernizing, high-scale regulated systems) and where FDE/AI-engineering skills are scarce. Explains why each boost applies. |
| DX-013 | M | P2 | **Channel mix coach (D-16).** Track applications and outcomes per channel (cold apply, referral, outreach, recruiter inbound). Recommend a weekly mix (e.g. "60% cold, 25% outreach/referral, 15% recruiter follow-ups") and adjust it from the user's own conversion data. |
| DX-014 | M | P2 | **Weekly diagnosis report.** Every Sunday: funnel deltas, hypothesis updates, the experiment that's running, and the single most important change for next week. |
| DX-015 | S | P2 | **Screen pitch and comp coaching.** Rehearse "tell me about yourself", "why did you leave Mastercard", "what have you been doing" and "salary expectations" with scoring for clarity, length and consistency with the thesis. |
| DX-016 | S | P2 | **Momentum and wellbeing guardrails.** Celebrate leading indicators (screens booked, response rate trending up, milestones shipped), not just offers. Frame rejections as data ("fed 3 data points to the diagnosis"). Pace the search to avoid burnout (cap daily review time; suggest rest days). |

## Acceptance criteria (selected)
- **DX-001:** Given a Gmail inbox with 9 months of job mail, ≥ 90% of real applications are reconstructed with the correct outcome. Uncertain ones land in a review queue, not in the data silently.
- **DX-003:** The report names the leakiest stage and shows the sample size. With fewer than 20 data points at a stage, it says "insufficient data" instead of guessing.
- **DX-011:** Entering an end date on an application form that differs from the canonical end date blocks auto-submit and raises a needs-human item.

## Discovery questions for the product owner (fills the first funnel before the app exists)
See `open-questions.md` Q-13. Rough numbers are fine: total applications, responses, screens, technical rounds, onsites; roles and levels targeted; channels used; remote/location constraints; comp expectation stated; any feedback received.

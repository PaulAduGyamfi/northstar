# 06 — Outreach (Cold & Warm Email)
Covers user ask **#9** (find emails to the right people at companies I apply to, draft helpful emails, human approval before send).

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| OUT-001 | M | P3 | For each application (or watchlist company), identify **target people**: hiring manager for the team, a recruiter for the role, an engineer on the team, and an alumni/ex-colleague connection if any. Rank by likely helpfulness. |
| OUT-002 | M | P3 | **Contact discovery** via compliant providers (e.g. Hunter, Apollo — Q-06) plus company email-pattern inference; every address gets a verification status (`verified`, `pattern-guess`, `unknown`). |
| OUT-003 | M | P3 | **Warm path first.** If the user's LinkedIn connections export / contacts show a mutual or ex-colleague (e.g. former Mastercard colleagues), recommend a referral ask before cold outreach. |
| OUT-004 | M | P3 | Draft a short, specific email per person: why them, why the user (one grounded proof point from the story bank), clear low-friction ask. Personalization from public signals (their talk, blog, repo, team launch) with sources cited in the draft view. |
| OUT-005 | M | P3 | **Approval required** for every send. Sent via the user's Gmail so replies land in their inbox and flow into 05. |
| OUT-006 | M | P3 | Sequencing: at most one follow-up after N days, stop on any reply; global daily send cap; per-company cap (don't email five people at once). |
| OUT-007 | S | P3 | Track outreach outcomes (reply, referral, intro) on the application timeline; report reply rates by persona and template. |
| OUT-008 | S | P3 | Compliance: honor opt-outs, include no deceptive subject lines, store only professional contact data with source and date. |

## Acceptance criteria (selected)
- **OUT-005:** Outreach drafts appear in the shared approval queue; sending without approval is impossible (same gateway as RPL-002).
- **OUT-006:** A reply from a contact cancels all pending follow-ups to everyone at that company within 5 min.

# 05 — Inbox, Pipeline & Recruiter Grading
Covers user asks **#4** (draft replies to follow-ups, approval needed), **#6** (categorize confirmations/responses into one place → dashboard), **#11** (grade inbound recruiter emails by my preferences).

## Requirements

### Ingestion & classification
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| INB-001 | M | P1 (read, labels) · P2 (drafts, send) | Connect Gmail via OAuth (scopes: read, modify labels, compose drafts; **send** is used only after approval). Near-real-time via Gmail push (Pub/Sub watch) with polling fallback. |
| INB-002 | M | P1 | Pre-filter to job-related mail (ATS sender domains, known company domains in pipeline, recruiter heuristics, keywords) before any LLM call; non-job mail is never sent to the model. |
| INB-003 | M | P2 | Classify each job email into: `confirmation`, `rejection`, `assessment`, `interview_request`, `scheduling`, `recruiter_inbound`, `follow_up_needed`, `offer`, `info/other`. Extract entities: company, role, requisition, contacts, dates, links, deadlines. |
| INB-004 | M | P1 | **Link to pipeline.** Match email → application in the order set by INB-009 (plus-address tag, then ATS thread IDs, then company, role and sender). Update application status automatically (e.g. rejection → `rejected`). Ambiguous matches go to a "confirm link" queue. |
| INB-005 | M | P1 | Apply Gmail labels (`Northstar/Confirmation`, `/Interview`, …) so the organization is visible in Gmail too. |
| INB-006 | S | P2 | Unified job inbox view in the app: threads grouped by application, with status and next action. |

### Attribution: who started the pipeline
The app must be able to prove which applications, replies and interviews Northstar started. Linking an email to an application (INB-004) isn't enough on its own: the application also has to say who started it.

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| INB-007 | M | P1 | **Origin on every application.** Each application records who started it, set once when it's created and never changed by later email matching: `northstar_auto` (Northstar submitted under an auto-approve policy, APPLY-004), `northstar_approved` (Northstar submitted after your approval, APPLY-005), `northstar_handoff` (Northstar prepared it and you finished a step by hand, APPLY-006), `outside` (you applied without Northstar and it was found later from email, DX-001), `recruiter_inbound` (a recruiter started it, REC-*). A correction is a new domain event, not an edit. |
| INB-008 | M | P1 | **Visible in the app and in Gmail.** Origin shows as a badge on the application card, timeline and pipeline (e.g. "Started by Northstar · auto-approved · applied 23 min after posting"). In Gmail every linked thread also gets `Northstar/Started-by-Northstar` or `Northstar/Outside`, next to the INB-005 type labels. |
| INB-009 | M | P1 | **Deterministic matching first.** Match an email to an application in this order and stop at the first hit: (1) the plus-address tag the email was sent to (VER-007); (2) ATS thread or requisition IDs and the confirmation captured at submit (APPLY-008); (3) sender domain, company and role within the application's active window. Steps 1–3 are plain code with no LLM. Only when none hits may an LLM propose a match, and that proposal always goes to the "confirm link" queue. Each link records which step made it. An email to a known tag always passes the INB-002 pre-filter. |
| INB-010 | S | P1 | **Credit report.** Pipeline and diagnostics split every stage (replied, screen, interview, offer) by origin, so the app can say "9 of 12 screens this month came from applications Northstar started" (feeds DX-013 and D-08). |

### Reply drafting (human-in-the-loop)
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| RPL-001 | M | P2 | For emails needing a response (scheduling, recruiter questions, assessments, follow-ups), draft a reply in the user's voice with context from the application, calendar availability, and answer bank. |
| RPL-002 | M | P2 | Draft is created both in the app's approval queue and as a Gmail draft. **Nothing is sent without explicit approval.** |
| RPL-003 | M | P2 | Scheduling replies propose real free slots from Calendar (08) honoring prep-buffer rules. |
| RPL-004 | S | P2 | **Follow-up nudges.** If an application/interview has no response after N days (configurable per stage), draft a polite follow-up for approval. |
| RPL-005 | S | P3 | Thank-you notes drafted within 2 h after each interview, referencing topics from prep notes. |

### Recruiter inbound grading
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| REC-001 | M | P2 | Grade each `recruiter_inbound` message A–F against preferences: role fit, seniority, comp (stated or estimated), location/remote, company quality/stage, agency vs in-house, personalization level, red flags. |
| REC-002 | M | P2 | Show grade with reasons; A/B → draft an interested reply; C → draft a "more info please" reply; D/F → draft a polite decline or suggest archive. All drafts require approval. |
| REC-003 | S | P2 | Preferences learn from user actions on graded emails. |
| REC-004 | C | P3 | Track recruiter/agency reputation across messages (responsiveness, quality of roles). |

## Acceptance criteria (selected)
- **INB-004:** A Greenhouse rejection email moves the matching application to `rejected` within 2 min and appears in the activity feed with the email snippet.
- **INB-007:** An application's origin is written in the same transaction as its first event, and a test proves a later email match can't change it.
- **INB-008:** An application Northstar submitted shows "Started by Northstar" in the app, and its ATS confirmation thread carries the `Northstar/Started-by-Northstar` label.
- **INB-009:** In a fixture test, an email sent to `candidate+ns-<code>@example.com` links to its application with match step `plus_tag` and makes no LLM call. An email with an unknown tag goes to the "confirm link" queue, never to a guess.
- **RPL-002:** No code path calls Gmail `send` without an approval record ID (enforced in the Gmail gateway, tested).
- **REC-001:** On a labeled set of 50 recruiter emails, grade agrees with the user's own A–F within one letter ≥ 85% of the time.

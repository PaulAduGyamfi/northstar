# 05 — Inbox, Pipeline & Recruiter Grading
Covers user asks **#4** (draft replies to follow-ups, approval needed), **#6** (categorize confirmations/responses into one place → dashboard), **#11** (grade inbound recruiter emails by my preferences).

## Requirements

### Ingestion & classification
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| INB-001 | M | P2 | Connect Gmail via OAuth (scopes: read, modify labels, compose drafts; **send** is used only after approval). Near-real-time via Gmail push (Pub/Sub watch) with polling fallback. |
| INB-002 | M | P2 | Pre-filter to job-related mail (ATS sender domains, known company domains in pipeline, recruiter heuristics, keywords) before any LLM call; non-job mail is never sent to the model. |
| INB-003 | M | P2 | Classify each job email into: `confirmation`, `rejection`, `assessment`, `interview_request`, `scheduling`, `recruiter_inbound`, `follow_up_needed`, `offer`, `info/other`. Extract entities: company, role, requisition, contacts, dates, links, deadlines. |
| INB-004 | M | P2 | **Link to pipeline.** Match email → application (by company, role, ATS thread IDs, sender). Update application status automatically (e.g. rejection → `rejected`). Ambiguous matches go to a "confirm link" queue. |
| INB-005 | M | P2 | Apply Gmail labels (`Northstar/Confirmation`, `/Interview`, …) so the organization is visible in Gmail too. |
| INB-006 | S | P2 | Unified job inbox view in the app: threads grouped by application, with status and next action. |

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
- **RPL-002:** No code path calls Gmail `send` without an approval record ID (enforced in the Gmail gateway, tested).
- **REC-001:** On a labeled set of 50 recruiter emails, grade agrees with the user's own A–F within one letter ≥ 85% of the time.

# 05 — Inbox, Pipeline & Recruiter Grading
Covers user asks **#4** (draft replies to follow-ups, approval needed), **#6** (categorize confirmations/responses into one place → dashboard), **#11** (grade inbound recruiter emails by my preferences).

## Requirements

### Ingestion & classification
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| INB-001 | M | P1 (read, labels) · P2 (drafts, send) | Connect Gmail via OAuth (scopes: read, modify labels, compose drafts; **send** is used only after approval). Near-real-time via Gmail push (Pub/Sub watch) with polling fallback. |
| INB-002 | M | P1 | Pre-filter to job-related mail (ATS sender domains, known company domains in pipeline, recruiter heuristics, keywords) before any LLM call; non-job mail is never sent to the model. |
| INB-003 | M | P2 | Classify each job email into: `confirmation`, `rejection`, `assessment`, `interview_request`, `scheduling`, `recruiter_inbound`, `follow_up_needed`, `offer`, `info/other`. Extract entities: company, role, requisition, contacts, dates, links, deadlines. |
| INB-004 | M | P1 (link) · P2 (status update) | **Link to pipeline.** Match email → application in the order set by INB-009 (plus-address tag, then ATS thread IDs, then company, role and sender). Ambiguous matches go to a "confirm link" queue. From P2, once INB-003 classifies the email, update application status automatically (e.g. rejection → `rejected`), subject to INB-011. In P1 emails are linked only and never change status. |
| INB-005 | M | P2 | Apply Gmail labels (`Northstar/Confirmation`, `/Interview`, …) so the organization is visible in Gmail too. |
| INB-006 | S | P2 | Unified job inbox view in the app: threads grouped by application, with status and next action. |

### Attribution: who started the pipeline
The app must be able to prove which applications, replies and interviews Northstar started. Linking an email to an application (INB-004) isn't enough on its own: the application also has to say who started it and how it was submitted.

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| INB-007 | M | P1 | **Origin on every application, in two parts.** (a) `started_by`, who started it: `northstar` (Northstar found the job), `outside` (you applied without Northstar and it was found later from email, DX-001) or `recruiter_inbound` (a recruiter started it, REC-*). Written when the application is created. (b) `submitted_via`, how it went out: `auto` (auto-approve policy, APPLY-004), `approved` (you approved it, APPLY-005), `handoff` (you finished a step by hand, APPLY-006) or `by_hand` (you applied outside Northstar, even to a job Northstar found). Written in the same transaction as the move to `submitted` (`transitionApplication`). "Started by Northstar" means `started_by = northstar` and `submitted_via` is not `by_hand`. Email matching never changes either part. Each value is a domain event and the latest one wins: a correction is a new event, never an edit in place (ADR-0012). |
| INB-008 | M | P1 | **Visible in the app and in Gmail.** Origin shows as a badge on the application card, timeline and pipeline (e.g. "Started by Northstar · auto-approved · applied 23 min after posting"). In Gmail every linked thread also gets `Northstar/Started-by-Northstar` or `Northstar/Outside`. Origin labels need only the link, so they ship in P1; the INB-005 type labels follow in P2. |
| INB-009 | M | P1 | **Deterministic matching first.** Match an email to an application in this order and stop at the first hit: (1) the plus-address tag the email was delivered to (VER-007). A tag maps to one application or to one tenant. A tenant tag only narrows the candidates: steps 2–3 choose among them, and if they can't, the email goes to the "confirm link" queue. An unknown `+ns-` tag always goes to that queue; (2) ATS thread or requisition IDs and the confirmation captured at submit (APPLY-008); (3) sender domain, company and role within the application's active window. Steps 1–3 are plain code with no LLM. Only when none hits may an LLM propose a match, and that proposal always goes to the "confirm link" queue. Each link records which step made it. An email to a known tag always passes the INB-002 pre-filter. |
| INB-011 | M | P1 | **A tag is not proof of the sender.** The tag identifies the application; it doesn't authenticate who wrote the email. The recipient tag is read from the Gmail-added `Delivered-To` header, never from `To` or `Cc`. Step 3 matches on the authenticated sender domain, not the `From:` header. Any automatic status change (INB-004, P2) needs both a deterministic link and `Authentication-Results` showing DMARC pass (or aligned DKIM pass) for a domain on the application's company or ATS allowlist. Otherwise the email is still linked, but the status change becomes a proposal in the "confirm link" queue. |
| INB-012 | M | P1 | **Verification mail never enters the inbox pipeline.** The Verification Catcher (VER-001…006) runs before INB-002, INB-003 and INB-004. A message consumed by an open verification window, or one matching the VER-003 code and link patterns, is never classified, never stored as a snippet, body or link, never sent to a model, and appears in the feed only as the VER-005 summary line. A tag match never replaces the VER-002 sender allowlist, the verification window or the VER-004 host check. |
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
- **INB-007:** `started_by` is written in the same transaction as the application's first event, and `submitted_via` in the same transaction as its move to `submitted`. A test proves a later email match can't change either.
- **INB-008:** An application Northstar submitted shows "Started by Northstar" in the app, and its ATS confirmation thread carries the `Northstar/Started-by-Northstar` label.
- **INB-009:** In a fixture test, an email sent to `candidate+ns-<code>@example.com` links to its application with match step `plus_tag` and makes no LLM call. An email with an unknown tag goes to the "confirm link" queue, never to a guess. A rejection sent to a tenant tag shared by two applications links only when steps 2–3 pick one; otherwise it goes to the queue.
- **INB-011:** A rejection sent to a known tag from an unauthenticated or non-allowlisted domain links to the application, leaves its status unchanged and raises a confirm item.
- **INB-012:** After a verification flow through a tagged address, the feed, events, extracted entities and LLM call records contain no code or link.
- **RPL-002:** No code path calls Gmail `send` without an approval record ID (enforced in the Gmail gateway, tested).
- **REC-001:** On a labeled set of 50 recruiter emails, grade agrees with the user's own A–F within one letter ≥ 85% of the time.

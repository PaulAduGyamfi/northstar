# 03 — Auto-Apply
Covers user asks **#1** (auto apply based on resume) and **#2** (answers that don't read as AI; reuse saved answers).

## Goal
Submitting an application costs the user **0 clicks** (fully autonomous, opted-in policy) or **1 click** (approve a batch). The system never stalls silently — when it needs the human, it says exactly why.

## How "doesn't read as AI" is handled (confirmed by product owner 2026-11-24)
The goal is **answers that don't read as AI-written** (meaning 1 below). "AI detection" has two meanings; we treat them differently on purpose:

1. **Content that reads as AI-written** — *in scope.* Solved by grounding every answer in the user's real stories and their measured writing style (04, VOICE-*), reusing human-approved answers, and learning from the user's edits. Authentic content is the durable fix; a "humanizer" that rewrites text to fool detectors is not, and recruiters increasingly screen for generic content anyway.
2. **Anti-bot / anti-automation controls** (CAPTCHAs, bot fingerprinting, rate limits) — *we do not evade these.* We submit through paths that don't need evasion (ATS-native forms at human pace, the user's own browser session) and hand off to the user when a challenge appears. Rationale and risk in ADR-0003. This keeps the user's accounts and candidacy safe; getting flagged as a bot by an employer's ATS is worse than a slower apply.

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| APPLY-001 | M | P1 | **Application package.** For each queued job, assemble: tailored resume (02), cover letter if required, answers to all form questions (04), and a field map. Package is a reviewable object before submission. |
| APPLY-002 | M | P1 | **ATS adapters.** Deterministic form-fill adapters for Greenhouse, Lever, Ashby (P1); Workday, SmartRecruiters, iCIMS, Workable (P2+). Adapters detect fields, map to profile/answers, upload files, submit, and capture the confirmation page. |
| APPLY-003 | M | P1 | **Generic adapter.** For unknown forms, an LLM-guided browser agent proposes a field map; first-time forms always require approval (no autonomous submit on unseen form shapes). |
| APPLY-004 | M | P1 | **Approval policies.** User sets per-rule autonomy: e.g. "Auto-submit if Fit ≥ 85, known ATS adapter, all answers from bank or high-confidence, no free-text question > 100 words"; otherwise queue for approval. Default: everything queues. |
| APPLY-005 | M | P1 | **1-click batch approval.** Approval queue shows N ready packages; user can approve all, approve some, or open any to edit. Approving triggers submission. |
| APPLY-006 | M | P1 | **Human-handoff.** On CAPTCHA, login wall, MFA, account creation, or unexpected page state: pause, notify the user, open the exact page in their browser (extension) with everything pre-filled, and resume tracking after they finish. |
| APPLY-007 | M | P1 | **Human-paced execution.** Submissions run at realistic pacing, one at a time per ATS domain, with daily caps (configurable; default 25/day) to protect the user's reputation and inboxes. |
| APPLY-008 | M | P1 | **Proof of submission.** Store screenshot + HTML of the confirmation page, timestamp, submitted field values, resume version. Shown on the application timeline. |
| APPLY-009 | M | P1 | **Idempotency.** Never apply to the same requisition twice; detect duplicates across sources and reposts. |
| APPLY-010 | M | P1 | ~~Browser-only account credentials.~~ **Superseded by ADR-0010 (2026-11-24):** accounts on Workday-style tenants are created, verified and signed into automatically, with passwords in Northstar's credential vault and mirrored to Paul's password manager. See [15-accounts-and-verification](15-accounts-and-verification.md). |
| APPLY-011 | S | P2 | **Kill switch.** One toggle pauses all submissions immediately (ApplyASAP parity). |
| APPLY-012 | S | P2 | **EEO / sensitive fields** (gender, race, veteran, disability, sponsorship, salary expectation) are answered only from explicit user settings, never inferred. |
| APPLY-013 | C | P3 | **Speed mode.** For "dream company" watchlist entries, auto-prepare a package within minutes of a posting appearing and push a high-priority 1-click approval notification. |

## Statuses (application state machine)
`discovered → scored → queued → package_ready → awaiting_approval → submitting → (needs_human) → submitted → confirmed → in_process(screen/onsite/…) → offer | rejected | withdrawn | ghosted`

Every transition emits an event (OBS-001).

## Acceptance criteria (selected)
- **APPLY-005:** From a push notification, approving a batch of 10 takes one tap and results in 10 submissions or 10 explicit `needs_human` items — never silent failures.
- **APPLY-006:** A CAPTCHA on submission produces a `needs_human` item within 10 s with a deep link that opens the pre-filled form.
- **APPLY-009:** Re-ingesting a job already applied to never triggers a second submission.

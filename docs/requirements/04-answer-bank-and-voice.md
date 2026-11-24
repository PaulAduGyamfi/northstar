# 04 — Answer Bank & Voice
Covers user asks **#2** (save answers that reappear) and **#7** (draft short answers in my voice from real experience, approve before submit, reuse later).

## Concepts
- **Question canon.** Application questions vary in wording but repeat in intent ("Why do you want to work here?", "Describe a challenging project", "Years of experience with X", "Are you authorized to work…"). Each incoming question is mapped to a **canonical question** (embedding similarity + LLM confirm).
- **Answer bank.** Human-approved answers stored per canonical question, with variants (short/long, company-specific slots), the stories they cite, and usage history.
- **Voice profile.** A measured description of how the user writes (sentence length, vocabulary, formality, tics, phrases they use and avoid), built from writing samples and every edit they make.

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| ANS-001 | M | P1 | Classify every form question: **factual** (work auth, years of X, location, start date, salary) → answered from profile settings; **reusable narrative** → answer bank; **company-specific narrative** ("Why us?") → drafted fresh with company research + bank template. |
| ANS-002 | M | P1 | Map each question to a canonical question with a confidence score; below threshold → treat as new. |
| ANS-003 | M | P1 | **Reuse.** If an approved answer exists for the canonical question, adapt it to length limits and company slots; show "reused from bank (used 7×)." |
| ANS-004 | M | P1 | **Draft.** For new narrative questions, retrieve relevant stories/atoms (CPG-002/003), draft in the voice profile, cite the stories used. |
| ANS-005 | M | P1 | **Approval.** New or substantially changed narrative answers always require approval (APPLY-004 policy may auto-approve exact reuse). User can edit inline; edits are saved. |
| ANS-006 | M | P1 | **Save on approve.** Approved answers are written back to the bank under the canonical question, linked to the application. |
| ANS-007 | M | P1 | **Voice profile bootstrapping.** User provides 5–10 samples of their own writing (emails, Slack, posts, past cover letters). System extracts a style guide; user reviews it. |
| ANS-008 | M | P1 | **Learn from edits.** Diffs between draft and approved text update the voice profile (e.g. "user always removes 'leverage'", "shortens openings"). |
| ANS-009 | S | P2 | **Authenticity check.** Before showing a draft, run a self-critique pass flagging generic phrases, clichés, uncited claims, and style drift vs. voice profile; rewrite until clean. Show the flags that were fixed. |
| ANS-010 | S | P2 | Answer bank UI: browse/search/edit canonical questions and answers; see where each was used and outcome of those applications. |
| ANS-011 | C | P3 | **Answer performance.** Correlate answer variants with response rates; surface the best-performing variant. |

## Acceptance criteria (selected)
- **ANS-002:** "What excites you about this role?" and "Why are you interested in this position?" map to the same canonical question.
- **ANS-004:** Every sentence making a factual claim about the user cites a story/atom ID; uncited claims fail validation.
- **ANS-008:** After the user deletes the same phrase in 3 drafts, the next draft does not contain it.

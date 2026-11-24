# 00 — Vision

## Problem
A strong engineer's job search is dominated by low-leverage work: finding postings, re-typing the same answers, tailoring resumes, triaging email, chasing follow-ups. That work crowds out the things that actually move outcomes — skill growth, interview prep, and relationships. Existing auto-apply tools (e.g. ApplyASAP) solve *submission volume* but are opaque, don't learn your voice, don't close the loop with your inbox or your skill development, and do nothing for inbound visibility.

## Primary user
One person: a full-stack SWE (4+ YOE, ex-Mastercard) running an active search while building side projects and studying for certifications. Single-tenant first; multi-tenant is a later decision (open question Q-02).

## Success criteria (from the product owner)

| # | Outcome | How we measure it |
|---|---|---|
| S1 | Applying is automatic and hands-free — at most 1 click | Median human clicks per submitted application ≤ 1; % of applications fully autonomous |
| S2 | Responsive, transparent — I know the status of everything | Every application has a live status; every agent action appears in the activity feed within 5 s |
| S3 | Progressive, structured skill growth | Each tracked project/course gets planned time every week; no project untouched > N days without a conscious decision |
| S4 | Focus shifts to skills, not applying | Weekly hours the user spends on applying (self-reported + clicks) trends toward < 1 h |
| S5 | Inbound recruiter email due to optimized profiles | Inbound recruiter emails / week; profile grade trend |

North-star metric: **qualified conversations per week** (recruiter screens + interviews), not applications sent.

## Product principles
1. **Glass box, not black box.** Every agent shows what it did, why, and with which inputs. Status is never a mystery.
2. **Truth-anchored generation.** Everything written in the user's name is grounded in a real, stored experience. No invented metrics, titles, or skills.
3. **Approval is a first-class object.** One approval queue for everything that needs a human, batched so "1 click" is real.
4. **Learn once, reuse forever.** Every answer, edit and approval teaches the system (answer bank, voice model, preferences).
5. **Quality over spray.** Volume is a lever, not the goal; scoring and preferences gate what gets sent.
6. **Close the loop.** Search outcomes feed skill priorities; skill progress feeds profiles; profiles feed inbound.
7. **Play by the rules.** Prefer official APIs; when a site says "prove you're human," the human steps in.

## Scope by phase (detail in `roadmap.md`)
- **P1 — Core loop:** candidate profile graph, job ingestion (link paste + ATS feeds), scoring, resume tailoring, answer bank, assisted apply for Greenhouse/Lever/Ashby, approval queue, activity feed.
- **P2 — Inbox & pipeline:** Gmail triage, pipeline dashboard, reply drafts, recruiter grading, calendar + interview prep.
- **P3 — Reach:** outreach (contact finding + cold email), profile scanner + grade, visibility checklist.
- **P4 — Growth & compounding:** growth tracker with balancing, skill-gap loop, outcome analytics, broader ATS coverage.

## Out of scope (for now)
- Applying through LinkedIn Easy Apply via automation (account-ban risk; see ADR-0003).
- CAPTCHA solving or anti-bot evasion.
- Negotiation/offer management beyond tracking.

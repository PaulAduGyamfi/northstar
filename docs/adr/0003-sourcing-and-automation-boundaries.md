# ADR-0003 — Sourcing and automation boundaries (no evasion; human handoff)

**Status:** Accepted · **Date:** 2026-11-24

> Product owner confirmed (2026-11-24): "bypass AI detection" means **answers that don't read as AI-written**. Anti-bot / CAPTCHA evasion is out of scope; challenges hand off to the user. Newly posted jobs are the sourcing priority (see SRC-012..015).

## Context
The ask includes "auto apply needs to bypass AI detection" and "scrape jobs from all over the web." Some platforms (LinkedIn, Indeed) prohibit scraping and automated applying and actively ban accounts; ATSs may present CAPTCHAs or bot checks. Getting the user's LinkedIn restricted, or being flagged as a bot by an employer, directly damages the search this product exists to help.

## Decision
**Sourcing**
- Primary: official/public ATS job-board APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) polled on a company watchlist. These are where most tech postings originate, so this covers the bulk of the market and is *fresher* than aggregators.
- Secondary: feeds with permissive terms (public RSS/JSON, HN Who's Hiring, YC WaaS, boards with APIs).
- Auth-walled/prohibited sites (LinkedIn, Indeed, Glassdoor): **user-initiated capture only** via the browser extension or link paste. No background crawling.
- Every source plugin declares a terms status; `prohibited` cannot be enabled (NFR-TOS-001).

**Applying**
- Submit through ATS forms with deterministic adapters at human pace (per-domain concurrency 1, daily caps).
- **No** CAPTCHA solving services, fingerprint spoofing, or stealth plugins.
- On any challenge, **hand off** to the user's own browser with the form pre-filled (APPLY-006). That handoff is the "1 click."

**"Doesn't read as AI"**
- Addressed by authenticity, not detector-evasion: provenance-anchored content from real stories, a measured voice profile, learning from edits, and a cliché/genericness critique pass (04).

## Consequences
- + Low risk to the user's accounts and reputation; durable — no arms race with anti-bot vendors.
- + ATS-direct sourcing gives a real freshness edge (apply within the first hour).
- − Some fraction of applications (Workday accounts, CAPTCHAs, LinkedIn-only roles) need a human click. We measure that fraction and drive it down with better adapters and batching, not evasion.

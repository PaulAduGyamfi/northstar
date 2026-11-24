# 01 — Job Sourcing & Ingestion
Covers user asks **#5** (paste a link from anywhere) and **#8** (web-wide sourcing, ApplyASAP-style).

Priority key: **M** must, **S** should, **C** could. Phase in brackets.

## Context: what ApplyASAP does (researched 2026-11-24)
- User sets titles, locations, pay floor, job type, hard requirements; system finds "fresh openings."
- Skips closed, fraudulent-looking, unqualified, and hard-requirement-mismatch jobs.
- Does **not** name its sources or define freshness; matching is human-team judgement.
- Monthly caps by tier (100 / 300 / 1,000).

We take the filters, skip rules and caps concept, and beat it on **freshness, transparency and source coverage** (see `differentiators.md` D-01).

## Requirements

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| SRC-001 | M | P1 | **Link ingest.** User pastes any job URL (web app, browser extension, or share-sheet/email-to-self). System fetches, extracts a normalized `Job` (title, company, location, remote policy, salary range, seniority, requirements, nice-to-haves, apply URL, ATS type, posting date) within 30 s and shows it in the feed. |
| SRC-002 | M | P1 | **Extension capture.** Browser extension "Save to Northstar" button captures the JD from the page DOM the user is viewing (handles auth-walled pages like LinkedIn since it reads what the user already sees). |
| SRC-003 | M | P1 | **ATS board polling.** Maintain a `CompanyWatchlist`; poll public job-board endpoints for Greenhouse, Lever, Ashby, SmartRecruiters, Workable on a schedule (default every 30 min; configurable per company tier). New postings are diffed and ingested. |
| SRC-004 | M | P1 | **Company discovery.** Seed and grow the watchlist automatically: from target-company lists, from companies in the user's pipeline, from similar-company expansion (same stage/industry/stack), and from aggregator feeds. Each company records which ATS it uses. |
| SRC-005 | S | P2 | **Aggregator & feed sources.** Ingest from sources with permissive access (public RSS/JSON feeds, HN "Who's Hiring" threads, YC Work at a Startup, remote job boards with APIs). Each source is a plugin with declared terms-of-use status (ADR-0003). |
| SRC-006 | M | P1 | **Normalization & dedupe.** Same role posted on multiple sources collapses into one `Job` with multiple `JobSource` records (fuzzy match on company + title + location + description embedding). |
| SRC-007 | M | P1 | **Search preferences.** Titles (with synonyms), seniority band, locations/remote, salary floor, job type, visa/sponsorship, company size/stage, industries to include/exclude, tech stack, hard requirements (dealbreakers). |
| SRC-008 | M | P1 | **Skip rules.** Auto-skip with a recorded reason: closed, likely fraudulent (heuristics: no company domain, pay-to-apply, mismatched domains), hard-requirement mismatch (clearance, license, language), already applied in last N days, company on blocklist. Skipped jobs remain viewable with reason. |
| SRC-009 | M | P1 | **Freshness tracking.** Store first-seen timestamp and source posting timestamp; feed sortable by "minutes since posted." |
| SRC-010 | S | P2 | **Liveness check.** Re-check open postings daily; mark closed jobs and update pipeline items that reference them. |
| SRC-011 | C | P3 | **Hidden-job signals.** Detect hiring signals before postings (funding rounds, new eng leadership, careers-page changes) and suggest outreach. |

### Freshness first (product owner priority, 2026-11-24)
Newly posted jobs are **the** priority. Every design trade-off in sourcing favors time-to-detect and time-to-apply.

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| SRC-012 | M | P1 | **Freshness SLO.** For watched companies: posting → in feed ≤ 15 min (p95) for Tier-1 ("dream") companies, ≤ 30 min for Tier-2, ≤ 2 h for the long tail. Poll cadence adapts per company to its historical posting times (poll faster during the hours it usually posts). |
| SRC-013 | M | P1 | **Fresh-first queue.** Packages are built and approvals ordered by `freshness × fit`, not fit alone. A 20-minute-old 82-fit job outranks a 5-day-old 90-fit job. Jobs older than a configurable age (default 7 days) are de-prioritized unless fit ≥ 90 or a referral path exists. |
| SRC-014 | M | P1 | **Time-to-apply metric.** Every application records `posted_at → detected_at → package_ready_at → approved_at → submitted_at`. Shown on the application and aggregated on the dashboard; the human approval delay is shown separately so the user can see when *they* are the bottleneck. |
| SRC-015 | S | P1 | **Fresh-job alerts.** High-fit jobs < 1 h old trigger a priority push ("Posted 12 min ago · Fit 88 · ready to approve"). Quiet hours respected except for Tier-1 companies (configurable). |
| SRC-016 | S | P2 | **Posting-pattern learning.** Learn when each company/ATS tends to publish (day/hour) and pre-warm scoring + research for those windows. |

### Preferences are live settings
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| SRC-017 | M | P1 | **Search preferences are editable any time in the app** (Settings → Search): target roles/titles, seniority, comp floor and target, locations/remote, company tiers, dealbreakers. No onboarding-only fields. Changes take effect on the next scoring run and re-score open jobs in the feed within 5 min; the activity feed records "Preferences changed: comp floor $X → $Y; 14 jobs re-scored." |
| SRC-018 | S | P1 | Preferences are versioned so the dashboard can compare outcomes before/after a change (feeds Search Diagnostics, 13). |

## Acceptance criteria (selected)
- **SRC-012:** In a synthetic test where a job appears on a Tier-1 Greenhouse board, it is in the feed with a Fit Score within 15 min at p95 over 100 trials.
- **SRC-013:** Given two jobs (fresh 82-fit, stale 90-fit), the approval queue lists the fresh one first.
- **SRC-017:** Changing the comp floor in Settings re-scores open feed items and shows the change in the activity feed without a restart.
- **SRC-001:** Given a Greenhouse, Lever, Ashby, Workday, or arbitrary careers-page URL, a `Job` with ≥ 90% field completeness is created; extraction failures surface as an editable draft, never a silent drop.
- **SRC-003:** A posting that appears on a watched Greenhouse board is in the feed ≤ 35 min later (p95) at default cadence.
- **SRC-006:** Ingesting the same role from two sources yields exactly one `Job` in the feed.
- **SRC-008:** Every skip shows a human-readable reason and can be overridden with one click ("apply anyway").

## Open points
- Which aggregators are acceptable under their terms → Q-05.
- LinkedIn/Indeed: capture-only via extension (user's own session, user-initiated). No background scraping (ADR-0003).

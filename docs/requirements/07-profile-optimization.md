# 07 — Profile Optimization, Grade & Visibility
Covers user asks **#10** (agent that checks GitHub, LinkedIn, personal site), **#13** (current profile grade), **#14** (link every possible profile for visibility).

## Goal
Make the user easy to find and compelling once found, so recruiters come to them (success criterion S5).

## Requirements

### Scanner
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| PRF-001 | M | P3 | **GitHub audit** (GitHub API): profile README, bio, pinned repos, repo READMEs/descriptions/topics, demo links, license, activity cadence, contribution graph gaps, stale/embarrassing public repos. |
| PRF-002 | M | P3 | **LinkedIn audit** via the browser extension reading the user's own profile page (no background scraping): headline, About, experience bullets vs. resume consistency, skills (top 3 pinned), featured section, custom URL, open-to-work settings, recommendations count, activity recency. Fallback: LinkedIn data export upload. |
| PRF-003 | M | P3 | **Personal site audit**: reachable, HTTPS, load performance (Lighthouse), mobile, title/meta/OG tags, structured data (`Person` schema), resume link, contact path, project write-ups, links to other profiles. |
| PRF-004 | M | P3 | **Consistency check** across resume, LinkedIn, GitHub, site: same title/headline narrative, dates, skills, photo, name format. |
| PRF-005 | M | P3 | **Keyword alignment**: compare profile text to the aggregated keyword set of the user's target jobs (from 01/02). Recruiters search LinkedIn by keywords; missing ones are surfaced. |
| PRF-006 | M | P3 | Scheduled re-scan (weekly) + on-demand; diff against last scan. |

### Grade
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| GRD-001 | M | P3 | **Profile Grade** (0–100 and letter) composed of: Discoverability, Credibility (proof: shipped projects, metrics, recommendations), Consistency, Freshness, Target-role alignment. Weighting visible. |
| GRD-002 | M | P3 | Every point lost maps to a concrete fix with estimated impact ("+6: add metrics to 3 Mastercard bullets on LinkedIn"). |
| GRD-003 | M | P3 | Fixes for text (headline, About, README) come with drafted replacements in the user's voice; **user applies them** (we don't write to LinkedIn). GitHub README changes can be opened as PRs on the user's repo after approval. |
| GRD-004 | S | P3 | Grade history chart; correlate with inbound recruiter volume (05, REC-*). |

### Visibility footprint
| ID | Pri | Phase | Requirement |
|---|---|---|---|
| VIS-001 | M | P3 | Maintain a **footprint checklist** of profiles worth having for a SWE, each with status (missing / exists / optimized) and a link: LinkedIn, GitHub, personal site, Google Scholar n/a, Stack Overflow, dev.to/Hashnode/Medium, X/Bluesky, Wellfound, Otta/Welcome to the Jungle, Hired-style marketplaces, Dice, Built In, YC Work at a Startup, Hacker News profile, Indeed/Glassdoor profiles, Levels.fyi, Credly (for AWS cert), Anthropic/Skilljar credential, Polywork-style link hubs, Google Knowledge Panel via `sameAs`. |
| VIS-002 | M | P3 | Recommend priority order by recruiter traffic for the user's target roles; don't push the user to maintain 20 profiles — mark which are "set and forget." |
| VIS-003 | S | P3 | Generate a canonical **profile kit** (headline variants, short/long bio, avatar, links block) for consistent setup across sites. |
| VIS-004 | S | P3 | Personal site gets `sameAs` JSON-LD linking all profiles (identity consolidation for search engines). |
| VIS-005 | C | P4 | "Search yourself" check: what Google / LinkedIn search shows for the user's name + target keywords. |

### Career DNA (idea dump, 2026-11-25)
A shareable career report: "Spotify Wrapped meets GitHub meets career discovery." It shows
demonstrated strengths, transferable skills, possible directions, overlooked strengths and evidence
gaps. **It is not a personality quiz.** Every line is grounded in the profile graph and says how sure
it is, and the shared moment leads somewhere useful (matching jobs, a fix, an introduction), not just
impressions. Why people share: self-discovery, identity, aspiration, utility (introductions) and
recognition.

| ID | Pri | Phase | Requirement |
|---|---|---|---|
| DNA-001 | M | P3 | **Career DNA report** built from the profile graph: experience atoms, approved stories, employment facts, imported sources (GitHub, LinkedIn export) and growth tracks. Every strength, label and direction cites atom or story IDs, and a deterministic check refuses any line without a citation (ADR-0004). |
| DNA-002 | M | P3 | **Strength dimensions scored by code.** A fixed, versioned rubric (e.g. engineering, architecture, infrastructure, leadership, communication, problem-solving; the set is chosen per target role family) scores each dimension from cited evidence. Each score shows its evidence count and a confidence band (low / medium / high). Too little evidence reads "not enough evidence yet", never a low score. The model may draft wording but never sets a score. |
| DNA-003 | M | P3 | **Archetype label** ("The Systems Builder") comes from the top dimensions through a fixed mapping. A "why this label" view lists the evidence. No personality-type or trait language that work evidence can't back. |
| DNA-004 | M | P3 | **Career directions lead to action.** Candidate roles are ranked by how well the evidence covers real requirements of jobs in the feed (MAT-*, SRC-*). Each one shows matched evidence, the main gaps, and how many fresh open jobs fit, with a link straight to them in the queue. |
| DNA-005 | S | P3 | **Overlooked strengths and transferable skills.** Well-evidenced atoms that the resume, LinkedIn headline or site don't mention become Profile Grade fixes (GRD-002). |
| DNA-006 | M | P3 | **Evidence gaps.** Dimensions or directions held back by weak proof suggest a proof-of-work track (GRW-008/009). |
| DNA-007 | M | P3 | **Share card.** An image plus a public page with confidence shown on the card itself and a footer saying the report is evidence-based and what it is built from. Private by default. Employer names, dates and metrics are hidden unless the user turns them on. Publishing needs an `approvalId` (Approval Gate, ADR-0002). Links can be revoked. The only analytics are a view count. Publishing and revoking carry an idempotency key and emit a domain event. None of the four ADR-0002 gateways covers publishing, so a Publish gateway needs an ADR-0002 amendment (or a new ADR) before this is built. Hosting follows Q-10. |
| DNA-008 | S | P3 | **Refresh and history.** Rebuilt when the profile changes. Versions are kept, and a "what changed since last time" diff gives the user a reason to come back. |
| DNA-009 | C | P4 | **Introductions from a shared card.** A viewer can ask for an introduction. The request lands in the user's inbox as data (NFR-SEC-004), and any reply is a draft the user approves. Nothing is sent automatically. Rate limits, spam handling and the retention and deletion of viewers' contact details (NFR-SEC-005) are decided in the DNA-010 ADR (NS-131). |
| DNA-010 | C | P4 | **Free public Career DNA** as a growth launch: anyone uploads a resume or LinkedIn export and gets their own report, which leads into Northstar. Depends on Q-02 (multi-tenant). Needs an ADR covering data retention and deletion, abuse, cost per report and consent before it is built. |

## Acceptance criteria (selected)
- **GRD-002:** Applying all suggested fixes and re-scanning increases the grade by roughly the sum of the stated impacts (± 5).
- **PRF-002:** No LinkedIn page is loaded without the user's browser and the user's action/schedule consent.
- **DNA-001/002:** A dimension with no cited atoms shows "not enough evidence yet". Removing one cited atom changes that score by the amount the rubric gives, with no model call.
- **DNA-007:** Publishing a share card without an `approvalId` is refused, and a revoked link returns 404.

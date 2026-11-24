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

## Acceptance criteria (selected)
- **GRD-002:** Applying all suggested fixes and re-scanning increases the grade by roughly the sum of the stated impacts (± 5).
- **PRF-002:** No LinkedIn page is loaded without the user's browser and the user's action/schedule consent.

# NS-130 slice 10: the jobs page, and directions linking to it

Issue: #54 · Requirements: DNA-004 ("each linking to matching fresh jobs in the queue"), SRC-013 (fresh
first), MAT-003 (bands) · ADR-0009, ADR-0018

## Why

Slice 9 put career directions on `/career-dna`, but a direction couldn't link to its jobs: there was no
jobs page. There is also no place in the app where Paul sees his scored jobs at all; only
`jobs list` in a terminal.

## What changes

1. **`GET /jobs`** (`apps/api/src/jobs.ts`, session only, read-only). It answers ready jobs whose posting
   isn't known to be closed (the Fit Score's own `readScorableJobs` set), in the queue's order: freshness
   × fit (`queueScore(freshness(ageHours), fit/100)`, `packages/sources/src/queue.ts`), at most 100.
   Each job has:
   - its title, company and place, through `postingText` (hidden characters removed, ≤ 200 chars);
   - its remote kind;
   - its age in whole hours, from the posting date or first seen;
   - its newest fit score, band and stretch flag, or none;
   - its posting link, only when that is an `https:` URL.

   No description, requirement or atom is sent. An optional `role` filter keeps the jobs whose title is
   in that role family (`roleFamily`, the grouping `careerDirections` uses). A role over 200 characters
   is refused.
2. **`url` on `listJobs`** (`packages/db`, a read): the job's canonical link, already stored. No migration.
3. **`/jobs` in `apps/web`** (new files): each job in words ("Posted 3 h ago", "Fit 88 · in the queue",
   "Remote"), its link opening the posting in a new tab with `noopener noreferrer`, and a heading naming
   the role when filtered, with a link back to all jobs. Signed out redirects to sign-in. No nav link:
   the five tabs are fixed (Paul's call).
4. **Directions link to their jobs** on `/career-dna`: each direction's role links to
   `/jobs?role=<role>`.

## Tests

- **API:** order by freshness × fit; closed and draft jobs left out; the role filter; text cleaned; a
  non-https link dropped; 401 without a session; 503 when a read fails; the 100 cap.
- **Web:** the age, fit and remote words; the link only for https; the role heading.
- **Sources:** `roleFamily` and the queue functions are exported unchanged.

## Not in this slice

A nav link, filters beyond role, approving or applying from the page, and a jobs count on Today.

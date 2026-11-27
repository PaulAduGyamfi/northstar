# NS-260: Watch Workday career sites like the other job boards

Issue: #371 · Parent: #14 (NS-115) · Requirements: SRC-003, SRC-012…016

## Why

Paul wants to watch companies that post on Workday (Amex, Citi, Deloitte). `jobs add <url>` reads one
Workday posting already (SRC-001), but `jobs watch add` refuses a Workday career site, so their fresh
postings reach Northstar only when Paul pastes each link.

## Terms (ADR-0003)

`terms.ts` already lists `*.myworkdayjobs.com` as `official-api`: the career site's own public job
JSON (`/wday/cxs/…`), the same endpoint the site loads for any visitor. No sign-in, no apply.

## What changes

1. `detectBoard` accepts `https://<tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>` (exactly the site,
   an optional `xx-XX` locale before it; a longer path is a posting, which is `jobs add`). The board
   is stored as `<tenant>.wd<N>/<site>` and the URL canonically as
   `https://<tenant>.wd<N>.myworkdayjobs.com/<site>`. The tenant is lower case (a host name).
2. `safeFetch` takes an optional JSON body, sent as a POST. A POST never follows a redirect: the 3xx
   comes back as the status, so the board read treats it as unavailable.
3. `listBoard` reads a Workday board with one POST to
   `https://<host>/wday/cxs/<tenant>/<site>/jobs` (`limit` 20, `offset` 0, empty search): the first
   page of open postings, in Workday's own order. Each posting maps to title, location, remote kind and
   a posted date (`postedOn`, the same rule as `jobs add`), with no description, like SmartRecruiters'
   listing. Its link is the site's posting URL, and its id is `<tenant>/<reqId>`, exactly what
   `detectAts` reads from that URL, so a job added by hand and the same job polled dedupe.
4. Everything else is the existing board path: the `source:workday` kill switch and breaker, backoff,
   quarantine, saving through `jobs add`'s path, fresh-first order.
5. `jobs watch add`'s help names the Workday shape; AGENTS.md's command row and the README say so.

## Limits

- One request per board per poll, so only the first 20 postings Workday lists are read each pass.
  Busy sites post more; tier 1 polls every 10 minutes. Reading more pages is a later ticket.
- No descriptions in the listing, so requirement matching sees only the title until Paul adds the
  posting with `jobs add` (which reads the full posting).
- Workday gives a relative age. "Posted Today" dates a posting at the poll's time (the rule `jobs add`
  already uses), so a site's first poll can alert on postings up to a day old as just posted. Later
  polls see them within one cadence of posting.
- Fresh-job alerts know a Workday posting's tier from its link (`jobTier`), so a tier-1 site may
  alert during quiet hours like any tier-1 board.

## Tests

Hand-written synthetic fixtures (`example`-style tenants), no live fetch: board detection (accepted and
refused shapes), the POST's URL and body, the mapping, a malformed posting skipped, a non-200 and a
redirect as `BoardUnavailable`, and that the polled id equals `detectAts`'s id for the same URL.

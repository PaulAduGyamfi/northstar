# NS-283: Research Service (company snapshots) and interview prep briefs

Status: approved (autonomous lane, ADR-0016; parent #121, issue #461)
Requirements: CAL-005 (prep brief), CAL-003/004 (prep blocks and reminders link to it), MAT-002
Rules that apply: ADR-0003 (no scraping against terms), ADR-0004 (no fabrication: every line
cites), ADR-0006, NFR-SEC-004 (untrusted text is data), `.claude/rules/db.md`, `tests.md`.

## Why
Prep blocks reach Paul's calendar (NS-241), but there is nothing to prepare with. The
architecture's Research Service (cached company snapshots) and the Prep Coach's briefs don't
exist. A brief must only say what a stored source or Paul's own profile backs.

## Behavior (by slice)

### Slice 1: plain-code snapshot and brief, with their checks (`packages/domain`)
- `buildCompanySnapshot(input)` (`company-snapshot.ts`) takes stored sources only: the company's
  name and its saved jobs (id, title, description, requirements, posting time, closed flag). It
  gives:
  - **about**: up to 2 sentences from a posting's description that name the company, verbatim,
    each citing that job (`job:<id>`);
  - **open roles**: the open jobs' titles, freshest first, at most 10, each citing its job;
  - **stack**: technologies from a fixed list (`STACK_TERMS`) named as whole words in the
    postings' requirements or descriptions, most-named first, at most 15, each citing the jobs
    that name it.
  Posting text is untrusted: it is only ever quoted, never read as an instruction, and a sentence
  with control, invisible-formatting or blank-looking characters is skipped. Each quote is at
  most 300 characters.
- `checkSnapshot(snapshot, sources)` refuses any line whose citation names no given source, or
  whose quoted text isn't verbatim in the cited job.
- `buildInterviewBrief(input)` (`interview-brief.ts`) for one interview combines the snapshot,
  the job's must-haves matched to atoms (the caller passes `matchRequirements`' result) with the
  evidence the caller selected per must-have (`selectEvidence`'s items: story and atom ids), and
  the unmatched must-haves as gaps to prepare. Every line carries at least one citation:
  `job:<id>`, `atom:<id>` or `story:<id>`. A gap line cites the job that asks for it.
- `checkInterviewBrief(brief, known)` refuses an uncited line, a citation to an unknown source,
  atom or story, and a gap line that cites an atom or story (a gap has no proof by definition).

### Later slices (each its own PR)
2. Storage: a versioned, append-only `company_snapshot` (one row per change per company, ids and
   cited text only) and the readers that feed slice 1 from stored jobs.
3. The brief on `/interviews`: the API reads a confirmed interview's job, the current resume
   import's atoms and Paul's approved stories, builds and checks the brief, and answers it
   read-only; the web page words it. Nothing is sent anywhere.
4. Company site read (done before slice 2, which waits for the migration lane; PR after #481):
   - `readCompanySite(deps, domain)` (`packages/sources`, `research/site.ts`) reads one company's
     home page, `https://<domain>/`, from a domain Paul entered (`jobs domains`), never one taken
     from a posting or mail. The caller passes the stored domain; the reader checks it again
     (`normalizeDomain`, `isSharedDomain`).
   - Its terms status is declared before any read (`companySiteTerms`: a prohibited site or an
     ATS host is refused; a company's own site is `public-feed`, source `company-site`).
   - It asks `robots.txt` first: a site-wide `Disallow: /` for `*` or a 5xx stops it before the
     page is read; no robots.txt (4xx) means no rules.
   - Both reads go through `safeFetch`. The page must end on the domain or a subdomain of it (a
     page redirected elsewhere is dropped, never quoted), answer 200 and be HTML.
   - `htmlText` (`research/html-text.ts`) turns it into visible text in one linear pass: scripts,
     styles, templates and the head dropped whole, blocks as lines, a few entities decoded, at
     most 50,000 characters.
   - Every failure is a reason (`SiteRefusal`), never a throw; one `research.site_read` span
     carries the domain and the outcome only.
   - In `packages/domain`, a `site` citation (the page's URL) joins `job`: the snapshot's about
     lines quote the site's sentences that name the company before the postings', and
     `checkSnapshot` and `checkInterviewBrief` check a site quote against the page's text. Only an
     about line may cite the site; roles, stack, match and gap lines cite postings.
   - No caller and no storage yet: slice 2 stores the snapshot (with the site quotes), slice 3
     reads the site when Paul opens a brief.
5. Optional model summary: a new route, off by default, with an eval set, whose every claim must
   quote a stored source (provenance check), until Paul records it.

## Acceptance criteria (slice 1)
- [ ] A synthetic company with three jobs gives a snapshot whose every line cites a job, and
      `checkSnapshot` accepts it.
- [ ] A synthetic interview gives a brief with matched must-haves citing atoms or stories, gaps
      citing the job, and snapshot lines; `checkInterviewBrief` accepts it.
- [ ] An uncited brief line, an unknown id and a gap citing an atom are each refused (tests).
- [ ] A sentence holding an instruction-like text is only quoted, and one holding U+202E is
      skipped (tests).
- [ ] `pnpm turbo run lint typecheck test build --filter=@northstar/domain` passes.
- [ ] AGENTS.md describes it.

## Failure modes
Pure code: a job with no description gives no about line; a company with no open jobs gives an
empty roles list. Nothing is fetched or stored in slice 1.

## Observability
None in slice 1 (no I/O). Slice 2 adds `company.snapshot_saved` (ids and counts only).

## Out of scope
Funding, news, eng blog and interviewer backgrounds (CAL-005 lists them; they need web research
beyond Paul's own domains and a later decision); likely question types; practice mode.

## Open questions
Paul's own company notes (#461 lists them) have no store yet; they wait for a later slice.

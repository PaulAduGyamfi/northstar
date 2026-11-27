# NS-252 slice 1: a company's own mail domains, entered by Paul

Status: in progress (autonomous lane, ADR-0016)
Issue: #313 (parent #293)
Requirements: INB-009 (linking mail to applications), INB-011 (only verified senders drive a status)
Decision (on #313): the domains Paul enters with `jobs domains` are the source of truth, stored
append-only with their source. Confirm-queue links may only suggest later. Never the apply URL's
host or ATS metadata, and never learned automatically.
Rules that apply: ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
`matchMail`'s step 3 (an authenticated company domain inside the application's active window)
never links, because nothing stores a company's own domains: `toLinkCandidate` passes
`companyDomains: []`. Interview detection matches nothing for the same reason.

## Behavior
- **Storage** (`packages/db`, migration 0096, `company-domain-schema.ts`): append-only
  `company_domain`, one row per change: candidate, company (composite foreign key to the
  candidate's own company), domain, `action` (`add` or `remove`) and `source` (`paul` only, for
  now). CHECKs: a lower-case domain of letters, digits, dots and hyphens with at least one dot, at
  most 253 characters. UPDATE, DELETE and TRUNCATE are refused by the shared trigger.
- **Write** (`company-domain-write.ts`): `setCompanyDomain(db, { candidateId, companyId, domain,
  action })` normalizes the domain (trim, lower case, trailing dot dropped) and checks its shape. It
  refuses:
  - an unknown company (`UnknownCompany`);
  - a bad shape (`InvalidDomain`);
  - a domain another of Paul's companies holds now (`ClaimedByOther`), so one domain never picks
    two companies.

  Adding a domain the company already holds, or removing one it doesn't, stores nothing. A change
  writes `company.domain_added` or `company.domain_removed` with a fixed feed line, and its payload
  holds the company id and the action only, never the domain. One transaction, serialized on the
  candidate row.
- **Read:** `readCompanyDomains(db, candidateId)` gives each company's current domains.
  `readLinkCandidates` adds `companyDomains` from it, through the job's company.
- **Inbox:** `CandidateRow` carries `companyDomains`, and `toLinkCandidate` passes them on.
  `matchMail` already ignores shared ATS and freemail domains (`ownDomains`) and links by sender
  only for an authenticated domain, so a stored domain can't widen those rules.
- **Command:** `jobs domains` lists each company with its id and domains. `jobs domains add
  <company-id> <domain>` and `jobs domains remove <company-id> <domain>` change one.

## Acceptance criteria
- [ ] The table refuses UPDATE and DELETE, a bad domain and another candidate's company (PGlite).
- [ ] Add, re-add (nothing stored), remove and the claimed-by-other refusal, each with its event
      (PGlite).
- [ ] `readLinkCandidates` gives a candidate its company's domains (PGlite).
- [ ] Linking by sender with stored domains: an authenticated company domain links, and these never
      link: freemail, a shared ATS domain, a lookalike domain, an unauthenticated sender (inbox tests).
- [ ] The CLI shows, adds and removes, and refuses a bad value with nothing stored (tests).
- [ ] lint, typecheck, test, build green in `packages/db`, `packages/inbox`, `packages/sources`
      (CI `checks`: this container's Node 22 can't install the workspace).

## Out of scope
- Suggestions from confirmed links (later, as an assist only).
- The pre-filter's `knownDomains` from the store: `pollNewMail` takes it from its caller (#230).

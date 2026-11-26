# NS-198: Settings → Accounts page and the consent-policy setting in the web app

Status: accepted (autonomous lane, ADR-0016)
Requirements: ACC-001 (tenants and their status), ACC-008 (consent policy and accepted notices)
Rules that apply: ADR-0002, ADR-0018, `.claude/rules/web.md`, `.claude/rules/db.md`,
`.claude/rules/tests.md`
Parent: #23

## Why
NS-124 stores the tenant registry, account statuses, the consent policy and accepted notices,
and the API lists tenants. Paul can't see any of it or change the policy.

## Behavior
1. **packages/db** (`consent-write.ts`, reads only, no migration):
   - `listConsentRecords` returns each accepted notice's tenant key, kind, https link and time.
     It never returns the text.
   - `readConsentText` returns one notice's text for its own candidate, or null.
2. **apps/api** (`consent.ts`). Every endpoint needs a session (`auth: "session"`), and a failed
   read answers 503:
   - `GET /settings/consent-policy` returns `{ policy }`.
   - `POST /settings/consent-policy` takes `{ policy }`, one of `auto` or `ask_per_tenant`, and
     saves it through `setConsentPolicy` (actor `user`). That change writes `consent.policy_set`,
     whose feed line already exists.
   - `GET /accounts/consents` lists the notices field by field, never the text.
   - `GET /accounts/consents/text?recordId=` returns one notice's text, or 404.
3. **apps/web** (`/settings/accounts`, linked from Today):
   - Each tenant shows its key, ATS, status in words (`.status-label`), when it was added and
     when it last changed. Never an email or password.
   - The policy choice: two radio buttons and a Save button, plus the line that marketing opt-ins
     are always declined.
   - Accepted notices: kind, tenant, day, the link (through `safeHref`, new tab,
     `rel="noopener noreferrer"`) and a "Show the text" button.
   - The plain logic is in `src/accounts.ts`.

## Acceptance criteria
- [ ] All four endpoints refuse a request without a session (401) and reach nothing.
- [ ] The policy reads `auto` by default, a saved choice reads back, and any other value is 400.
- [ ] The notice list carries no text, email or extra field even if the read returns one, and a
      notice's text is given only for that candidate's record.
- [ ] The page's rows show no email or password (a web test of the plain logic), and a non-https
      link is not linked.
- [ ] A policy change shows as a feed line (`consent.policy_set`, written by `setConsentPolicy`;
      its template is in `feed.ts`).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
API or Postgres down: each card says it can't be read right now, and a save says "Not saved". A
save that times out says it may have gone through (`TIMED_OUT_MESSAGE`).

## Observability
`consent.policy_set` (existing) for each change; `api.request` spans per call.

## Out of scope
- Asking Paul per tenant through the Approval Gate (that comes with account creation, NS-197).
- Revealing a vault password (NS-182).

## Decisions made without Paul (ADR-0016)
- **Where the page lives:** the nav's five tabs are fixed by `tokens.md`, so the page is linked
  from Today rather than adding a sixth tab.

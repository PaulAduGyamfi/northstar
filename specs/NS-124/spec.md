# NS-124: Tenant registry, one account per tenant, and the consent policy (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: ACC-001, ACC-006, ACC-008 (this slice); ACC-002…005 follow up
Rules that apply: ADR-0002, ADR-0003, ADR-0010, ADR-0012, ADR-0016; `.claude/rules/db.md`,
`gateways.md`, `tests.md`

## Why
Workday and similar ATSs make Paul create an account per employer before he can apply. Northstar
needs to know which employer tenants he has an account on, what state each is in, and never create
a second account on the same tenant. Terms and privacy notices accepted on his behalf must follow
one rule he set, with the exact text kept.

Account creation, sign-in and the Workday form all drive a browser, and there is no real browser
driver until NS-142 (#76, needs Paul). So this slice builds what everything else stands on: the
registry, the one-account guard and the consent policy, in plain code and storage.

## Behavior
1. **Account states** (`packages/domain`, `tenant-account.ts`): `none`, `creating`, `verifying`,
   `active`, `locked`, `needs_human` (ACC-001), with the allowed moves as a table and
   `nextAccountStatus(from, to)`:
   - `none` → `creating` (start creating an account);
   - `creating` → `verifying`, `active`, `needs_human`;
   - `verifying` → `active`, `needs_human`;
   - `active` → `locked`, `needs_human`;
   - `locked` → `active` (after a reset), `needs_human`;
   - `needs_human` → `active` (Paul finished it), `none` (Paul says there is no account after all).
2. **The registry** (`packages/db`, one migration plus an append-only trigger migration):
   - `employer_tenant`: one row per candidate and tenant key (`<ats>:<tenant>`, the vault's
     pattern), with the ATS, the tenant's https URL, and the account email. Created once,
     never changed.
   - `tenant_account_status`: append-only. Each row is one status change: tenant, from, to,
     reason code, when. The newest row is the current status; no row means `none`.
   - Writes go only through `tenant-write.ts`:
     - `registerTenant` (create or return the existing one, never a second);
     - `moveAccount(tenantKey, from, to, reason)` (the move must be allowed and `from` must
       still be current, under a row lock);
     - `listTenants` (each tenant with its current status and dates).
3. **One account per tenant** (ACC-006): `beginAccountCreation(tenantKey)` moves `none` →
   `creating` under the tenant's row lock. A second caller sees `creating` (or later) and gets
   `AlreadyStarted` with the current status, so it signs in or waits instead of creating another.
4. **Consent policy** (ACC-008, `packages/domain`, `consent.ts`): `decideConsent(policy, notice)`
   returns:
   - `decline` for any marketing opt-in;
   - `accept` for a standard candidate terms or privacy notice under the `auto` policy (the
     default);
   - `ask` under `ask_per_tenant`.
   Stored in `packages/db` (`consent-write.ts`):
   - `consent_policy`: append-only, one row per change; no row means `auto`.
   - `consent_record`: append-only. Each accepted notice's tenant, kind, https URL, the text's
     SHA-256 and the text itself, and when. `recordConsent` refuses a marketing notice.
5. **API** (`apps/api`, `auth: "session"`): `GET /accounts` lists the registry (tenant key, ATS,
   status, created, last change). It never returns a password or the account email. The email is
   Paul's address, and the list doesn't need it.
6. Feed lines for `tenant.registered`, `tenant.account_changed`, `consent.recorded` and
   `consent.policy_set`.

## Acceptance criteria
- [ ] `nextAccountStatus` allows exactly the moves above (domain test over every pair).
- [ ] Registering the same tenant twice returns the same row; a tenant key or URL that breaks the
      rules is refused by the database.
- [ ] `beginAccountCreation` run twice, including concurrently, starts exactly one creation
      (ACC-006, PGlite test).
- [ ] A move from a status that is no longer current is refused, and nothing is stored.
- [ ] Status rows, consent rows and policy rows can't be updated, deleted or truncated.
- [ ] `decideConsent` declines every marketing notice under both policies; `recordConsent` refuses
      one.
- [ ] Events carry the tenant key, ATS, statuses, reason codes, notice kind and text hash, never
      the email, URL or notice text.
- [ ] `GET /accounts` refuses a request without a session and returns no email.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Postgres down:** writes throw and nothing is half-stored (one transaction each); `GET /accounts`
  answers 503.
- **Two creators race:** the tenant row lock serialises them; the second gets `AlreadyStarted`.
- **A notice changes after acceptance:** a new record with the new hash; the old one stays.

## Observability
- Events `tenant.registered`, `tenant.account_changed`, `consent.recorded` and
  `consent.policy_set`, each with a feed line.
- Spans `db.tenant.*` and `db.consent.*`, carrying the tenant key and the outcome or error kind.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #23`)
- Creating an account, signing in and reusing the session, and the Workday adapter (ACC-002…004).
  These need the Playwright driver (NS-142, #76).
- Password reset by email with the Verification Catcher (ACC-005).
- The Settings → Accounts page in the web app, and a CLI to set the consent policy.
- Linking applications to tenants (`linked applications` in ACC-001), which comes with the
  Workday adapter.

## Open questions
- Is `needs_human` → `none` right for "there is no account after all"? It is the only way back to
  creating one, and only Paul can take it.

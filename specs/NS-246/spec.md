# NS-246: The "Reveal" button on Settings → Accounts (slice 1, the page)

Status: draft (autonomous lane, ADR-0016)
Requirements: CRD-002, ACC-001 · ADR-0024 (Proposed), ADR-0022, ADR-0018
Rules that apply: `.claude/rules/web.md`, `.claude/rules/gateways.md` (vault boundary),
`.claude/rules/tests.md`. Issue #290 (Parent: #286).

## Why
The API can reveal one of Paul's vault passwords after a fresh passkey check (NS-230, NS-245), but
there is no page to ask for it. When he needs to sign in to an employer's site himself, he
should get the password in two clicks, see it once, and have it gone again.

## Behavior
- **The button.** Each tenant row on Settings → Accounts gets a "Reveal password" button. Clicking
  it calls `revealPassword(tenantKey, credentials)` (`apps/web/src/reveal.ts`, plain code):
  - `POST /api/vault/reveal/options` with `{ tenantKey }`, then the browser's passkey prompt for
    that challenge (`navigator.credentials.get`, the same conversions as sign-in);
  - then `POST /api/vault/reveal` with `{ tenantKey, response }`.
- **Showing it.** The password is shown in the row, in a monospace field, with how many seconds
  remain. After 30 seconds (`MASK_AFTER_MS`) it is cleared from the component's state. It is also
  cleared when Paul clicks "Hide" or leaves the page. It is never put in `localStorage`,
  `sessionStorage`, a cookie, the URL or a log.
- **Failures in plain words.** The API's answers become messages, and no password is shown for any
  of them:
  - 401: the passkey wasn't accepted;
  - 403: the wrong address;
  - 404: no password is saved for this account;
  - 429: too many tries;
  - 503: the vault is locked;
  - the browser cancelling the prompt, a timeout, or a dropped connection.
- **Nothing else changes.** The vault boundary test's allow-lists stay as they are. The page names
  only the API paths, never `revealTenantPassword` or the other functions the test watches.

## Acceptance criteria
- [ ] A reveal asks for options for that tenant, runs one passkey prompt and posts one reveal, and
      returns the password. These are tested with a fake credentials container and a fake fetch.
- [ ] Each failure status gives its message and no password.
- [ ] The password is cleared after 30 seconds (fake timers), and Hide clears it at once.
- [ ] Nothing is written to `localStorage` or `sessionStorage` (a test with spies).
- [ ] The security reviewer passes.
- [ ] AGENTS.md says the page exists.

## Out of scope
- The three `packages/db` guards from #290: a reveal decision only behind `reveal_to_user`, a feed
  line for `approval.requested` on `vault_reveal`, and `withdrawApproval` answering `NotFound`.
  They are slice 2, next to the Gate work another agent holds now.
- Any change to the API routes or the boundary test.

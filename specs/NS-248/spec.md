# NS-248 item 1: the tagged address on application forms

Status: in progress (autonomous lane, ADR-0016)
Issue: #294 (item 1; parent #224)
Requirements: VER-007, APPLY-001
Rules that apply: ADR-0002, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
`taggedAddress` and `assignTag` exist (NS-158), and `matchMail` links mail by its tag first, but
no package puts a tagged address on a form. Every application goes out with Paul's plain address,
so step 1 of linking never fires.

## Behavior
- **`packages/domain`** (`mail-tag.ts`): `MAIL_TAG_PATTERN`, `generateMailTag` and
  `taggedAddress`, the same rules as `packages/inbox`'s `tag.ts`. `packages/pipeline` and
  `packages/db` don't depend on `packages/inbox`, and adding that dependency needs Paul. A parity
  test in `packages/funnel`, which depends on both, keeps the two copies the same.
- **`packages/db`** (`mail-link-write.ts`): `readApplicationTag(db, candidateId, applicationId)`
  reads the application's tag, or null. It is read-only.
- **`preparePackage`** (`packages/pipeline`): once a package can be built, it assigns the
  application's tag (`assignTag`, which keeps the first tag) and puts
  `taggedAddress(contact.email, tag)` in the package's `contact.email`. A stored address that
  already has a `+` part goes out unchanged, so tags never stack. A rerun gets the same tag, so the
  same package id and Gate request.
- **The Gate** (`requestPackageApproval`): the package's email must be Paul's stored address, or
  that address tagged with this application's own stored tag. Another application's tag, or any
  other address, is refused as `package.contact`.
- Per-tenant tags (accounts, Workday) wait for account creation (NS-124/NS-142): today's packages
  are Greenhouse only, which needs no account.

## Acceptance criteria
- [ ] A filed package's email is the application's tagged address, and a rerun files the same
      package with the same tag (PGlite).
- [ ] The Gate accepts the tagged address and refuses another application's tag (PGlite).
- [ ] `taggedAddress` matches `packages/inbox`'s for the same inputs (parity test).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Item 2 (the credit report's inbox stages).
- Per-tenant tags.

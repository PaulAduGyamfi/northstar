# NS-203 slice 4: Paul edits a waiting application package's answers

Status: in progress (autonomous lane, ADR-0016)
Issue: #179
Requirements: APR-002, APPLY-004
Rules that apply: ADR-0002, ADR-0012, ADR-0016, ADR-0017, `.claude/rules/db.md`

## Why
Slices 1–3 let Paul edit a waiting reply draft. A waiting application package can only be
approved or rejected: to change one answer he has to reject the whole package. The issue's open
item is editing packages, with edited answers counting as `new` and the facts derived again.

## Behavior
- `editPackage(db, { candidateId, requestId, fields })` (`packages/db`, `package-edit.ts`):
  - reads the stored package behind the candidate's pending `application_package` request
    (`NotFound` otherwise);
  - changes only fields the package already fills with text, each to non-blank text (`\r\n` →
    `\n`); a new field, a blank value or a list of picked choices is `InvalidRequest` naming the
    field (never its value); the posting, contact, resume and cover letter stay as filed;
  - derives the edited package's facts again with `derivePackage` (split out of
    `requestPackageApproval`, which now uses it too) and **no bank claims**, so every field counts
    as `new`; the same posting, contact and newest-PDF checks apply;
  - calls `editRequest` with those facts, which in one transaction withdraws the old request by
    `user`, files the new one with the same kind and subject (the package id is kept), links them
    in `approval_edit`, and rolls back if a policy approved it; then stores the edited package
    behind the new request (`storePackage`).
  - Repeating the same edit returns the same new request; an unchanged package is
    `ContentUnchanged`; a decided or withdrawn request is `NotPending`.
- `editRequest` allows `application_package` only with facts (only `editPackage` passes them) and
  `email_reply` only without, so the existing "edits only reply requests" test still holds for a
  bare call.
- Migration 0106 (custom SQL): `approval_edit_guard` allows `application_package` beside
  `email_reply`.

## Acceptance criteria
- [ ] An edit withdraws the old request as Paul's, files one under the same subject, links them,
      and stores the edited package with only the edited field changed (PGlite).
- [ ] The edited request's facts are derived again with every answer `new`; a policy that approved
      the package as filed never approves the edit.
- [ ] A repeat returns the same request; unknown, blank and unchanged edits, decided requests and
      another candidate's package are refused.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- The API route and the Queue's Edit view for packages (next slice).
- Editing banked answers (a later slice).
- Adding an answer to a field the package left blank, or editing picked choices.

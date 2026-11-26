# NS-213 (slice 1): The Gate derives an application package's policy facts itself

Status: in progress
Requirements: APR-004, APPLY-003, APPLY-004
Rules that apply: ADR-0002, ADR-0016, ADR-0017, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #69, issue #195 item 1.

## Why
`requestApproval` trusts the facts its producer passes for an application package: fit, adapter,
form seen before, answer sources and free-text length. A confused or buggy producer could make a
package match one of Paul's auto-approve rules. The Gate should read those facts from stored
records instead.

## Behavior
`requestPackageApproval(db, { candidateId, package, claims, actor, idempotencyKey })` in
`packages/db` (`package-approval.ts`) files an application package with the Gate:
1. Parses the package (`parsePackage`); it must name one of the candidate's own applications, or the
   request is `InvalidRequest`.
2. Derives the facts from storage (`readPackageInputs`):
   - `fit`: the job's newest stored fit score, or null.
   - `adapter`: `known`. Every ATS the package schema allows has a deterministic adapter.
   - `formSeenBefore`: the stored-shape check from slice 5 of NS-227, only when the current form
     is on the package's ATS; otherwise false.
   - `answers`, one per filled field (plus a `new` one for a cover letter):
     - `freeTextWords`: the value's words, or 0 when the stored form says the field is a choice.
     - `source`: `new`, unless the producer claims a bank answer for that field and the Gate
       verifies the claim: the field is in the stored form, the candidate has that banked answer
       (id and version), and the field's value is exactly that answer's chosen variant with only
       its `{company}` slot filled by the job's company. A verified claim keeps the producer's
       `bank_exact` or `bank_high_confidence`; anything else counts as `new`.
3. Calls `requestApproval` with the package's own subject and SHA-256 and the derived facts.

`filePackage` (`packages/pipeline`) now files through it, passing only its bank claims.

What stays trusted: the split between `bank_exact` and `bank_high_confidence` (it depends on the
question canon in `packages/profile`, which `packages/db` can't import). A claim can only keep it
when the field's value is Paul's own approved text, so a wrong claim can't put new text past him.

## Acceptance criteria
- [ ] Facts on the stored request come from storage: fit, form seen before, word counts.
- [ ] A bank claim is kept only when verified; a changed text, an unknown answer, a field missing
      from the form or an unfilled slot makes it `new`.
- [ ] An unknown or another candidate's application is refused.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
Database only: a failed read throws and nothing is filed, so the caller's retry or dead letter
applies.

## Observability
`requestApproval`'s own `approval.request` span and `approval.requested` event, unchanged.

## Decisions made without Paul (ADR-0016)
- The bank-claim verification above, and keeping the exact/high split as the producer's.
- `requestApproval` keeps accepting facts for packages: closing it changes existing tests'
  assertions, so that goes to a `needs:paul` follow-up.

## Out of scope
- Item 2 (signalling waiting workflows): needs the worker process (#230).
- An adapter registry: today every allowed ATS has an adapter.

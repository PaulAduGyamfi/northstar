# NS-161: Application package assembly (slice 1: assemble and file with the Gate)

Status: approved under ADR-0016 (autonomous lane); home decided on #182 (NS-205)
Requirements: APPLY-001, ANS-001, ANS-003
Rules that apply: ADR-0002, ADR-0004, ADR-0017, ADR-0016, `.claude/rules/gateways.md`

## Why
The Approval Gate (NS-119) and the Apply Gateway (NS-120) take an application package as given,
but nothing builds one. Paul should get a reviewable package in his queue, with every answer
traceable to something he approved, and never a guess.

## Behavior
- New `packages/pipeline` (decision on #182, recorded in ADR-0023): plain-code pipeline steps,
  no model and no network.
- `assemblePackage(input)` is pure. Its input: the job's ATS, posting id and apply URL, the company
  name, Paul's contact, the tailored resume file (already validated when stored, NS-146), the
  form's questions (field name, label, required, length limit, choices), Paul's factual settings
  and his banked answers by canonical question. Its output:
  - each question answered from a factual setting (`answerFactual`, ANS-001) or a banked answer
    (`adaptAnswer`, ANS-003), with the source of every answer (setting, or bank answer id and
    version);
  - or `NeedsHuman` listing every question it can't answer and why (no setting, no banked
    answer, too long, a choice the answer isn't one of, an unsafe company name...). Optional
    questions it can't answer are left blank, never guessed;
  - a cover letter is used only when given; a form that requires one without it is `NeedsHuman`
    (`cover_letter`): no cover-letter drafting exists yet;
  - the package is checked with `parsePackage` and hashed with `packageSha256`.
- The policy facts it reports: `adapter: "known"` (every `APPLY_ATS` has an adapter), the fit
  score given, `formSeenBefore` given, and per answer `bank_exact` (a banked answer matched with
  confidence 1), `bank_high_confidence` (any other banked match) or `new` (factual settings: each
  one is marked for Paul's review, so they never count as reuse).
- `filePackage(db, …)` files an assembled package with the Gate: `requestApproval` of kind
  `application_package`, subject `application_package:<packageId>`, its SHA-256 and facts,
  actor `system`, idempotency key `package:<packageId>`. It never submits.

## Acceptance criteria
- [x] A synthetic job, contact, resume, settings and bank yield a package that passes
      `parsePackage`, with each answer's source (unit tests).
- [x] Unanswerable required questions, a required cover letter without one, a too-long answer
      and a choice mismatch each give `NeedsHuman` with the field and reason; nothing is guessed.
- [x] `filePackage` lands the package in the Gate as pending (`listPendingApprovals`), and filing
      it again replays rather than duplicating (PGlite test).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- Database down while filing: `requestApproval` throws; the caller retries with the same
  idempotency key, which replays.
- Bad input (a non-https URL, a missing contact field): `InvalidPackage` naming the fields.

## Observability
`requestApproval`'s `approval.request` span and the Gate's events. Assembly itself is pure.

## Out of scope (follow-ups)
- Form questions from the ATS readers in `packages/sources` (Greenhouse `?questions=true`, Lever,
  Ashby), stored with the job (#182, option a).
- The caller that loads the inputs (tailored resume file bytes and their storage, contact,
  settings, bank) and the worker activity that runs it.
- Cover-letter drafting.

## Open questions
None blocking.

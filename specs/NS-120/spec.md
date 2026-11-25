# NS-120: Apply Gateway: Greenhouse, Lever, Ashby adapters + proof of submission

Status: agent-approved under ADR-0016 (Paul reviews after merge; see the PR's "Decisions made
without Paul")
Requirements: APPLY-001 (the package as a checked, hashable object), APPLY-002 (Greenhouse, Lever,
Ashby field mapping and confirmation check), APPLY-007 (one at a time per ATS, daily cap, gap
between submissions), APPLY-008 (proof of submission), APPLY-009 (never the same requisition twice)
Rules that apply: ADR-0002, ADR-0003, ADR-0007, ADR-0012, ADR-0017, `.claude/rules/gateways.md`,
`db.md`, `tests.md`

## Why
Approving a package has to end in a real application on the employer's ATS, exactly once, with
proof Paul can look at later. The Approval Gate (NS-119) records approvals; nothing acts on them
yet. This ticket builds the Apply Gateway: the only code that may submit an application. It
checks the approval at the moment it acts, refuses duplicates, paces itself, and stores what it
sent and the confirmation page.

## Scope of this slice
The gateway, the three adapters' deterministic field mapping and confirmation checks, and the
database ledger are built and tested against synthetic form snapshots. **The real browser driver
(Playwright) is not in this PR**: it needs a new dependency and real ATS pages to record fixtures
from, so it is a follow-up issue. Until it lands the gateway has no production driver and can't
submit anything.

## Behavior

### The package (APPLY-001)
- `ApplicationPackage` (Zod, `packages/domain/src/apply-package.ts`): package id, application id,
  ATS (`greenhouse`, `lever`, `ashby`), the ATS's posting id, the apply URL, contact fields, the
  resume (file name + SHA-256), an optional cover letter, and the field map: one value per form
  field the package fills, keyed by the form's own field name.
- `packageSha256(pkg)` hashes a canonical JSON form (sorted keys). The producer passes this hash
  to `requestApproval`; the gateway recomputes it from what it is about to send. Subject:
  `application_package:<packageId>`.

### Submitting (`submitApplication`, `packages/gateways/src/apply/`)
In order, stopping at the first refusal:
1. The package parses, and its apply URL is https on that ATS's own host (Greenhouse
   `boards.greenhouse.io` / `job-boards.greenhouse.io`, Lever `jobs.lever.co`, Ashby
   `jobs.ashbyhq.com`). Anything else is refused (`InvalidPackage`, `HostNotAllowed`).
2. `verifyApproval` with the given decision id, kind `application_package`, the subject and the
   recomputed hash. Any refusal is returned as `NotApproved` with the Gate's reason; nothing else
   happens. The gateway never trusts the id without this lookup.
3. The resume (and cover letter) bytes are read by hash and re-hashed. A mismatch is refused
   (`FileChanged`).
4. **Claim** in one transaction (`claimSubmission`, `packages/db/src/apply-write.ts`), using the
   database clock:
   - idempotency key `application:<applicationId>:submit`. A finished submission with that key is
     returned as a replay (same proof, nothing sent). An `in_progress` one (a crash mid-run) is
     **never** retried: the outcome is unknown, so it becomes `needs_human` (`outcome_unknown`).
   - requisition key `<ats>:<postingId>`: a second application to the same requisition is
     refused (`DuplicateRequisition`, APPLY-009). Reposts under a new posting id are caught one
     level up: dedupe makes them one job (SRC-006), and one job has one application.
   - pacing (APPLY-007): one submission in progress per ATS (`AtsBusy`), at least 90 s since the
     last one started on that ATS (`Paced` with the time to retry), and at most 25 started in the
     last 24 hours (`DailyCapReached`). Cap and gap are options with those defaults.
   - The claim records the decision id that authorized it.
5. The application moves `awaiting_approval → submitting` through `transitionApplication`.
6. The driver opens the apply URL. A CAPTCHA, login wall, MFA or account step is not solved: the
   submission ends `needs_human` with that reason (ADR-0003). The adapter maps the package onto
   the form snapshot: standard fields from the contact block, the resume upload, every other
   field from the field map. A required field with no value (`unmapped_required`) or a field-map
   entry the form no longer has (`form_changed`) ends `needs_human` before anything is typed.
7. The driver fills, uploads and submits. The adapter checks the resulting page for that ATS's
   confirmation (deterministic markers). No confirmation → `needs_human` (`no_confirmation`).
   A driver error after the claim → `needs_human` (`driver_error`), never a retry: we can't know
   whether it went out.
8. On confirmation: the proof (confirmation HTML, PNG screenshot, their SHA-256s, the submitted
   field values, the resume hash, the database time) is stored with the submission marked
   `submitted` in one transaction, then the application moves `submitting → submitted`.
   On `needs_human` the application moves `submitting → needs_human`.

### Database (`apply_submission`, `submission_proof`)
- `apply_submission`: unique per idempotency key, per requisition key and per application; a
  partial unique index allows one `in_progress` row per ATS; status `in_progress`, `submitted` or
  `needs_human` (with a reason code). Only `in_progress` rows may change, once.
- `submission_proof`: one per submission, append-only (trigger refuses UPDATE, DELETE, TRUNCATE).

## Acceptance criteria
- [ ] A call without a valid approval (unknown id, rejected, undone, in its undo window, other
      subject, changed content) is refused and claims nothing (gateway tests, one per reason).
- [ ] Submitting the same approved package twice sends once; the second call returns the first
      proof (gateway test with a counting fake driver).
- [ ] A crash after the claim is never retried: the next call returns `needs_human`
      `outcome_unknown` and the driver is not called (gateway test).
- [ ] A second application to the same requisition is refused (db test).
- [ ] One in-progress submission per ATS, a 90 s gap and a daily cap of 25 (db tests).
- [ ] CAPTCHA, unmapped required field, changed form, no confirmation and driver error each end
      `needs_human` with that reason and the application in `needs_human` (gateway tests).
- [ ] A confirmed submission stores HTML, screenshot, field values, resume hash and time, and the
      application is `submitted` (gateway + db tests); the proof row can't be changed (db test).
- [ ] Each adapter maps its synthetic form snapshot and recognizes its confirmation page
      (adapter tests); an apply URL on another host is refused.
- [ ] `pnpm turbo run lint typecheck test build` is green.

## Failure modes
- **ATS slow or down / driver crash:** `needs_human` (`driver_error`), never a silent drop or a
  blind retry. Paul finishes it by hand (APPLY-006 handoff is NS-121).
- **Challenge (CAPTCHA, login, MFA, account):** `needs_human` with the challenge kind.
- **Form changed since the package was built:** `needs_human` (`form_changed` /
  `unmapped_required`) before anything is typed.
- **Database down:** the claim fails and nothing is sent; the caller sees the error.
- **Gate refuses:** `NotApproved` with the Gate's reason; nothing is claimed.

## Observability
- Span `apply.submit` with `northstar.apply.ats` and `northstar.apply.outcome`
  (`submitted`, `replayed`, a refusal kind or a `needs_human` reason). Never field values,
  URLs or HTML.
- Events (aggregate `application:<id>`): `apply.submission_claimed`, `apply.submitted`,
  `apply.needs_human` (reason code), each with ids and the ATS only; plus the status events
  `transitionApplication` writes.

## Out of scope
- The Playwright driver, recorded real ATS fixtures, file upload mechanics (follow-up issue).
- Human handoff through the extension (APPLY-006, NS-121), kill switch (APPLY-011), EEO fields
  (APPLY-012), the generic adapter (APPLY-003), Workday and other ATSs.
- Storing packages and building them (tailoring, answers): the gateway takes a package that was
  approved by hash.
- `submitted_via` on the application (INB-007).
- Object storage for proof files: they are kept in Postgres for now (small, one per submission).

## Open questions
- 90 s minimum gap and pacing per ATS (not per tenant) are inferred from APPLY-007's "realistic
  pacing, one at a time per ATS domain"; per ATS is the stricter reading.
- Rolling 24 hours for the daily cap (not a calendar day in Paul's time zone).

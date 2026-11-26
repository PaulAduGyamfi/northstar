# NS-227 (slice 5): Everything a package needs, read in one place, and the "needs you" event

Status: built
Requirements: APPLY-001 (assemble from stored data), APPLY-003 (a form seen before), APPLY-006
(what code can't finish goes to Paul, visibly)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`. Parent: #112, issue
#235 item 2.

## Why
The package caller (slice 6) needs, for one application: its job's company and ATS sources, Paul's
contact details, the newest tailored resume and its stored PDF, his factual settings, his banked
answers, the job's current form, its fit score, and whether this form's shape was seen before
(only from stored form shapes, never from model or extension output, per #235). When the
package can't be finished, the result must be a domain event and a visible feed line, with ids and
reason codes only. This slice is the `packages/db` side of that; the caller is plain code in
`packages/pipeline` and comes next.

## Behavior
- **`readPackageInputs(db, candidateId, applicationId)`** (`package-read.ts`, read-only) gives
  null for an unknown, malformed or other candidate's application, else:
  - the application's id, status and job id, and the company's name (null when unknown);
  - the job's sources: ATS, link and the ATS's posting id, oldest first;
  - `readContact`, `readProfileSettings`, the newest banked answer per canonical question;
  - the newest tailored resume version and its PDF's SHA-256 (null before NS-227 slice 2);
  - the current form (ATS, SHA-256, questions) or null;
  - the newest fit score or null;
  - `formSeenBefore`: true only when the Apply Gateway sent another job's application (its ledger
    row finished `submitted`) while that job's form, the newest read before the submission
    started, had this form's ATS and SHA-256. Paul's own submissions (by hand, or "I submitted it"
    on a handoff) have no ledger row and never count, and nor does a shape the other job took on
    after it went out (both reviewers of this slice).
- **`recordPackageNeedsHuman(db, { candidateId, applicationId, reasons, basis })`**
  (`package-write.ts`) writes `package.needs_human` on the application. Not an `application.*`
  type: `feedLine` reads every one of those as a status move. It carries
  the application id, each reason code with its count, and the total, and a `reason` of fixed
  words and a number, which is the feed line: "The application package needs you: 3 items".
  - Reason codes must be short snake_case words (a CHECK in code); no field names or text.
  - The key is `application:<id>:package_needs_human:<basis>`, where `basis` is the caller's
    SHA-256 of what it assembled from. The same basis again writes nothing (`recorded: false`), so
    a rerun on unchanged inputs isn't a second feed line.

## Plan and tasks
1. `readPackageInputs` with PGlite tests (each field, scoping, `formSeenBefore` both ways).
2. `recordPackageNeedsHuman` with PGlite tests (event shape, once per basis, refused codes).
3. Exports; AGENTS.md and `.claude/rules/db.md`.

## Acceptance criteria
- [x] The inputs are read for the candidate's own application only, each newest where versions
      exist.
- [x] `formSeenBefore` is true only for the same ATS and shape on another job the Apply Gateway sent.
- [x] The needs-you event has ids, codes and counts only, is written once per basis, and refuses a
      code that isn't a short snake_case word.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope
- The caller (slice 6): mapping the inputs, the NeedsHuman reasons, `packageId`, filing and the
  status moves. No schema change here.

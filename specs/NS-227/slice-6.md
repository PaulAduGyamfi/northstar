# NS-227 (slice 6): The caller that assembles and files a package

Status: done
Requirements: APPLY-001 (assemble and file), APPLY-003 (seen-before forms only from stored
shapes), APPLY-006 (what code can't finish goes to Paul, visibly), RES-006 (safe to repeat)
Rules that apply: ADR-0016, ADR-0017, ADR-0023, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #112, issue #235 item 2.

## Why
Slices 1 to 5 built every piece: the stored form, the resume file, the contact, the form's
questions, and one read of all of a package's inputs. Nothing yet puts them together, files the
package with the Gate and moves the application along.

## Behavior
`preparePackage(db, { candidateId, applicationId })` in `packages/pipeline` (`prepare.ts`), plain
code with no model or network:
1. Reads `readPackageInputs`. An unknown application is `refused: not_found`. One that isn't
   `queued` (or `package_ready`, left by a run that crashed after filing) is
   `refused: not_queued`, so it never files a second package beside one Paul is deciding.
2. Collects what stops it, as reason codes with counts:
   - `no_ats_source`: no Greenhouse source with a posting id (only Greenhouse has stored forms);
   - `no_form`: no stored Greenhouse form;
   - `no_contact`: Paul has no contact details;
   - `no_resume_file`: no tailored resume, or one from before PDFs were stored;
   - `no_phone`: the form requires a phone and Paul's contact has none (slice 4's duty);
   - `file_upload`: each required upload Northstar can't fill (slice 4's duty);
   - and, once `assemblePackage` runs, each unanswered question's reason (`no_bank_answer`,
     `not_a_choice`, `cover_letter`, …) and `invalid_package` for a malformed one.
   Any reason makes it `needs_human`: `recordPackageNeedsHuman` writes the feed line, with a basis
   that is the SHA-256 of what it assembled from (form, resume file, contact, settings, banked
   answer versions and the reasons). Unchanged inputs don't repeat the line. Nothing is filed.
3. Otherwise it opens a round by moving the application `queued → package_ready`, files the
   package with `filePackage`, then moves it `package_ready → awaiting_approval`, each move keyed
   `application:<id>:package:<packageId>:<status>` (`transitionApplication`).
   - **`packageId`** is derived from the application id, the round (how many rounds the
     application had before, `readPackageRounds`) and the SHA-256 of the package built with a
     placeholder id (a version 8 UUID from the hash). In one round the same inputs give the same
     id, so a rerun after a crash replays the first Gate request (`package:<packageId>`) instead
     of filing a second. After Paul rejects a package and the application goes back to `queued`,
     the next round gets a new id even for the same content.
   - A run that crashed at `package_ready` resumes with that round's id. If the inputs changed
     since, it files nothing and records `inputs_changed`, so no second package sits beside the
     first.
   - `autoApproved` is true only for a policy's approval made as the request was filed. A
     replayed request reports its decision as it is (`approved`, `rejected` or none).
   - `file_refused` and `move_refused` come back as values: the caller (#230) dead-letters them.
   - The resume goes as `<first>-<last>-resume.pdf` (letters, digits and hyphens only), else
     `resume.pdf`.
   - `fit` and `formSeenBefore` come from the stored rows only, never from a model or the
     extension (#235).

## Plan and tasks
1. `packageIdFor` and `resumeFileName`, with unit tests.
2. `readPackageRounds` (`packages/db`) and `preparePackage`, with PGlite tests: each refusal,
   each needs-human reason (`no_phone` and `file_upload` each stop it before filing), once per
   basis, a filed package and its status moves, a crash after filing replaying the same request,
   a rejected replay, changed inputs after a crash, and a new round after a rejection.
3. Export; AGENTS.md.

## Acceptance criteria
- [x] A complete application is filed once with the Gate and reaches `awaiting_approval`; a rerun
      files nothing new.
- [x] A required phone with none stored, and a required upload, each stop it before filing, with a
      feed line.
- [x] Missing inputs and unanswered questions are reason codes in the feed line, recorded once per
      basis.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- How `packageId` is chosen (above), as #235 asks, with the round in it (from the reviews).
- An application left at `package_ready` by a crashed run is finished on the next run; with
  changed inputs it becomes `inputs_changed` for Paul.
- `readPackageRounds` reads rounds from the application's own events (no schema change).

## Out of scope
- What calls `preparePackage` (the worker, #230), recording banked-answer reuse when a package
  goes out, and the question confirm step (off by default).

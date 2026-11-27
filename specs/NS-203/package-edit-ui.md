# NS-203 slice 5: the Queue shows and edits a waiting application package's answers

Status: in progress (autonomous lane, ADR-0016)
Issue: #179
Requirements: APR-002, APPLY-004, UX-014
Rules that apply: ADR-0002, ADR-0016, ADR-0018, `.claude/rules/web.md`, `.claude/rules/db.md`

## Why
Slice 4 added `editPackage` in `packages/db`, but nothing calls it: Paul still can't see a waiting
application's answers in the Queue, let alone change one.

## Behavior
- `readPackageAnswers(db, candidateId, requestId)` (`packages/db`, `package-edit.ts`): the stored
  package's filled fields, each with the stored form's label (else the field name), its value (a
  list of choices joined) and whether `editPackage` would take an edit (text, not a choice field).
  Never the contact details, files or apply URL. Null when nothing is stored.
- API (`apps/api/src/approvals.ts`, session only, mirroring the reply routes):
  - `GET /approvals/package?requestId=` answers `{ answers }` field by field, or `404 not_found`.
  - `POST /approvals/edit-package { requestId, fields }` (1–200 fields, values 1–10,000
    characters) calls `editPackage` and answers `{ requestId }` of the new request, or the reply
    edit's codes (`not_pending`, `unchanged`, `not_editable`, `not_found`, `invalid_body`).
- Web (`/approvals`): on a waiting "Application", "Show the answers" lists `label: value` lines
  (`packageLines`; a choice says it isn't editable here; an edited request says so). "Edit" opens a
  textarea per text answer; Save sends only the changed ones (`changedAnswers`) after
  `packageEditProblem` (nothing changed, empty, over 10,000 characters), words the answer with
  `packageEditResultWords` (a second click's `409 not_pending` reads as done) and reloads.

## Acceptance criteria
- [ ] `readPackageAnswers` gives labels, values and editability, and nothing for another candidate
      (PGlite).
- [ ] The API routes answer as above, need a session, and refuse an empty value before the Gate.
- [ ] The web helpers word lines, changes, problems and results (unit tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Editing banked answers (a later slice); editing choice fields or adding an answer.

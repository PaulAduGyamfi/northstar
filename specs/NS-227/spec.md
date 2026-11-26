# NS-227 (slice 1): Form questions from the ATS readers, stored with the job

Status: built
Requirements: APPLY-001 (package assembly needs the form), ANS-001, ANS-003
Rules that apply: ADR-0016, `.claude/rules/gateways.md` (job sources), `.claude/rules/db.md`,
`.claude/rules/tests.md`. Parent: #112. Decision on #182: option (a), the ATS readers.

## Why
`assemblePackage` (NS-161) answers a form's questions, but nothing knows a posting's questions.

## Behavior
- **Greenhouse** (`packages/sources/src/ats/greenhouse-form.ts`): `readGreenhouseForm` asks the
  public job-board API for one posting with `?questions=true` (through `safeFetch`, like the
  posting reader) and maps each question's fields to a stored question:
  `{ fieldName, label, required, kind, choices, group }`.
  - `kind`: `text`, `textarea`, `select`, `multi_select`, `file` or `hidden`, from Greenhouse's
    field type; an unknown type makes the whole form unreadable (null), never a guess.
  - `choices`: each value's label and value for select kinds, else null.
  - `group`: the question's index, so a resume's file field and its paste-in textarea are known to
    be alternatives.
  - Only `questions` are read. `location_questions`, `compliance` and `demographic_questions`
    (voluntary EEO) are left out of this slice.
  - Lever and Ashby: their public posting APIs publish no application questions, so their forms
    wait for the browser driver (NS-142). Recorded in the PR.
  - Labels and choices are the employer's text: stored and compared by plain code, never sent to a
    model.
- **Storage** (`packages/db`, `job-form-schema.ts`, `job-form-write.ts`): append-only `job_form`
  (one row per distinct form of a job: the ATS, the questions as JSON and their SHA-256; the newest
  is current). `saveJobForm` stores a form only when it differs from the job's current (newest)
  one, under a lock on the job row, so a form that comes back after a change (A, B, A) is stored
  again and becomes current; it writes `job.form_read` (job id, ATS, question count).
  `readJobForm` reads the current one; `readJobAtsSources` lists a job's sources (ATS and link),
  and the command finds the Greenhouse board and posting id in the link with `detectAts`.
  At most 200 fields, every label, field name and choice at most 1,000 characters, and at most 500
  choices per field, or nothing is stored.
- **Command** `jobs form <job-id>` (its own usage line, so `jobs`' usage doesn't change): reads and
  stores a saved Greenhouse job's form and prints how many questions and which are required, or
  says why not (not Greenhouse, the API didn't answer, unreadable, unchanged). Paul only.

## Acceptance criteria
- [x] The reader maps every Greenhouse field kind, keeps groups and choices, and refuses an
      unknown type or a non-200 answer (fake web).
- [x] `saveJobForm` stores once per distinct form, with one event; the bounds refuse; the table is
      append-only; `readJobForm` gives the newest (PGlite).
- [x] `jobs form` prints counts, the required labels, and each refusal (CLI test).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope (rest of #235)
- The caller that assembles and files a package (slice 2), resume file storage (slice 3), reading
  the form during `jobs add` and polling, and the compliance and demographic questions.

# NS-227 (slice 4): A stored form, as the questions a package answers

Status: in progress
Requirements: APPLY-001 (assemble the package from the form), APPLY-006 (what code can't fill
goes to Paul)
Rules that apply: ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/tests.md`. Parent: #112,
issue #235 item 2.

## Why
`assemblePackage` takes `FormQuestion`s (field name, label, required, length limit, choices) plus
`coverLetterRequired`. Slice 1 stores a Greenhouse form as `JobFormQuestion`s (kinds, groups, choice
labels and values). Something has to turn one into the other, and decide which fields are not
questions at all: the adapter fills the standard ones from the contact and the files.

## Behavior
`formQuestions(questions: JobFormQuestion[])` in `packages/pipeline` (`form.ts`), plain code:
- **Standard fields** (Greenhouse's `first_name`, `last_name`, `email`, `phone`, `resume`,
  `cover_letter`, as the Greenhouse adapter names them, and the paste-in alternatives
  `resume_text` and `cover_letter_text`) are not questions. A required `cover_letter` group sets
  `coverLetterRequired`, and a required `phone` sets `phoneRequired`, so the caller can stop when
  Paul has no phone stored.
- **Hidden fields** are skipped: the form fills them itself.
- **Other file uploads** can't be filled by Northstar. A required one goes into `unsupported` with
  reason `file_upload`, so the caller makes the package NeedsHuman. An optional one is skipped.
- **Text and textarea** become questions with no length limit (Greenhouse publishes none) and
  no choices.
- **Select and multi-select** become questions whose choices are the option labels. The
  employer's text is compared by plain code only. The browser driver (NS-142) picks an option by
  its label.

## Plan and tasks
1. `formQuestions` with unit tests (synthetic forms).
2. Export it from `packages/pipeline`; the AGENTS.md note.

## Acceptance criteria
- [ ] Standard fields, hidden fields and optional uploads give no question.
- [ ] A required cover letter and a required phone are flagged.
- [ ] A required unknown upload is `unsupported`.
- [ ] Text and selects become questions with labels as choices.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Out of scope (rest of #235)
- The caller (slice 5): reading the inputs, `formSeenBefore`, choosing `packageId`, filing, the
  status moves and the NeedsHuman event.

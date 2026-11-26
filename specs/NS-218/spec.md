# NS-218: Act on closed postings: pipeline items and the Apply Gateway

Status: built
Requirements: SRC-010 (posting liveness), ADR-0007 (never a silent drop), APPLY-009
Rules that apply: ADR-0016, `.claude/rules/gateways.md`, `.claude/rules/db.md`,
`.claude/rules/tests.md`. Parent: #124. Builds on NS-173 slice 2 (`posting_check`,
`readClosedJobIds`) and NS-161 (package assembly).

## Why
`jobs check` closes a saved job after two closed answers in a row (`job.closed`), and the job
leaves scoring. But an application for that job keeps waiting in the pipeline, and the Apply
Gateway would still try to submit it to a dead posting.

## Behavior
- **State machine: no new status.** A closed job's application that hasn't gone out moves to the
  existing `withdrawn` (already legal from `discovered` through `awaiting_approval`), and its
  event's payload carries `reasonCode: "posting_closed"`. `transitionApplication` gains an
  optional `reasonCode`, stored in the event and part of the replay check.
- **`withdrawClosedApplications(db, candidateId)`** (`packages/db`, `liveness-write.ts`): every
  application in `discovered`, `scored`, `queued`, `package_ready` or `awaiting_approval` whose
  job is closed moves to `withdrawn` through `transitionApplication` (actor `system`, fixed words,
  key `application:<id>:posting_closed`). `submitting`, `needs_human` and anything later are
  left alone: a run may be in the browser, or it already went out. One failing application never
  stops the others; the result counts withdrawn and failed.
- **`jobs check`** runs it at the end of every pass (also catching a pass that crashed after
  closing a job) and prints how many applications left the pipeline.
- **The Apply Gateway refuses a closed posting.** After the Gate and the file check, before the
  switches, the claim or the browser, `submitApplication` asks `isPostingClosed` (the application's
  job by its two newest answers) and returns the refusal `PostingClosed`: nothing claimed, no
  `needs_human`, no move. The worker's `decide` finishes on it (not a wait).
- Feed: `application.withdrawn` with `posting_closed` reads "Application withdrawn: the job's
  posting closed".

## Acceptance criteria
- [x] An open application before submission whose job closed moves to `withdrawn` with
      `reasonCode: "posting_closed"`, once (run twice: one event); a submitting or submitted one
      doesn't move; an open job's application doesn't move.
- [x] `submitApplication` refuses `PostingClosed` before claiming, on fakes and on the db ports.
- [x] `checkPass` runs the withdrawal after the pass and a failure there doesn't fail the pass.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Out of scope
- Withdrawing a waiting Gate request for an application that left the pipeline (the gateway
  refuses it anyway); follow-up.
- Package assembly's own check (`assemblePackage` has no caller or job input yet; the gateway
  refusal is the last line). The caller that assembles packages (#235) should skip closed jobs.
- A daily liveness pass inside `jobs run` (stays the separate `jobs check`).

## Open questions
- None: the issue left the status choice open; this takes `withdrawn` with a reason code (recorded
  in the PR).

# NS-280: the job pipeline workflow (a queued job to a filed package to a submission run)

Status: in progress (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #458 (parent #112)
Requirements: MAT-001…003, TLR-001…004, ANS-001…003, APPLY-001…004, APR-*, RES-001/006 ·
ADR-0001, ADR-0002, ADR-0023
Rules that apply: `.claude/rules/db.md`, `.claude/rules/worker.md`, `.claude/rules/tests.md`

## Why
Every piece of the core loop exists, but nothing connects them: `preparePackage` has no caller,
nothing starts `submissionWorkflow`, and scoring, tailoring and the Gate only run from commands.

## Slices (one PR each)
1. **Queue a job (this PR).** Plain code turns a ready job into a `queued` application.
2. **`jobPipelineWorkflow` on `pipeline`.** For a queued application: tailor and store the resume
   (`tailorForJob`), read the form (Greenhouse first), run `preparePackage` (files with the Gate),
   then start `submissionWorkflow` for that round (`startSubmission`). `NeedsHuman` from any step is
   the existing visible `package.needs_human`. Ids only in workflow history.
3. **A starter.** The worker ensures one schedule that queues jobs and starts a pipeline run per
   newly queued application, only while a setting is on (off by default). The `auto_apply` kill
   switch and the Apply Gateway's pacing caps stay authoritative.

## Slice 1: the queueing rule
- `readQueueCandidates` (`packages/db`, `queue-read.ts`, read-only): the candidate's `ready` jobs
  whose newest Fit Score (by `scored_at`, the alert pass's rule) is in the `queue` band, with no
  application yet (`application_one_per_job`) and a posting not known closed
  (`readClosedJobIds`), freshest first (`coalesce(posted_at, first_seen_at)`), at most 50. Ids only.
- `countQueuedToday` (same file): `application.created` events of the candidate today (UTC, by the
  Gate's clock) with `startedBy: northstar` and `to: queued`.
- `queueReadyJobs` (`packages/pipeline`, `queue.ts`, plain code): reads both, then creates at most
  `dailyCap − queuedToday` applications through `createApplication` (`status: queued`,
  `startedBy: northstar`, key `job:<jobId>:queue`), so a repeat or a race replays the first
  application and the database's one-application-per-job key holds. Returns counts only.
  `dailyCap` is the caller's (1–25; APPLY-007's 25 a day is the ceiling); the caller and its
  setting come in slice 3, so nothing queues anything yet.

## Acceptance criteria (slice 1)
- [ ] The reader lists only ready jobs whose newest score is `queue`, with no application and an
      open posting; never a draft, a job whose newer score left the band, a closed posting or
      another candidate's job.
- [ ] `queueReadyJobs` creates one `queued` application per candidate job with `startedBy:
      northstar`, a second run creates nothing, and it never passes the daily cap.
- [ ] lint, typecheck, test and build green for `@northstar/db` and `@northstar/pipeline`.

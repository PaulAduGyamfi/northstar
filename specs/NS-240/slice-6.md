# NS-240 slice 6: a command that runs interview detection once

Status: draft
Requirements: CAL-002 (detect interviews on the calendar)
Rules that apply: ADR-0026 (Calendar read-only, consent each run, no stored token), ADR-0014
(token in memory for one run), ADR-0007 (breakers), ADR-0016, `.claude/rules/inbox.md`,
`.claude/rules/db.md`

## Why
Everything for detecting interviews exists except a caller: the Calendar client and its consent
flow (slices 1 and 3), storage and Paul's decision (slice 2), the run (slice 4) and the confirm
page (slice 5). Nothing reads the calendar yet, so `/interviews` stays empty.

## Behavior
- `pnpm --filter @northstar/funnel funnel interviews` (Paul only):
  1. opens Google's consent page for `calendar.events.readonly` (`authorizeCalendar`); the token
     lives in memory for this run only and is never stored, logged or printed;
  2. runs `runInterviewDetection` over the next 30 days with:
     - `listEvents` from `createCalendarClient`, behind the stored `calendar` breaker;
     - candidates from `readLinkCandidates` (open applications, active from their creation, with
       the company domains Paul entered through `jobs domains`);
     - `record` bound to `recordInterviewDetection`;
     - `deadLetter` bound to `recordDeadLetter` with the candidate id;
  3. prints counts only: events read, interviews found, new, unchanged, ambiguous, not matched,
     refused (too many changes, daily limit, skipped), and a pointer to `/interviews` when any
     are new. A stopped run says where it stopped and that rerunning is safe; exit code 1.
- When no application has company domains, it says so (nothing can match) and still runs, so the
  counts show what was read.
- It lives in `packages/funnel`, the one package that already depends on both `@northstar/inbox`
  and `@northstar/db`, so no lock file change.

## Acceptance criteria
- [ ] `funnel interviews` with extra arguments prints the usage and exits 1.
- [ ] A finished run prints its counts and exits 0; a run with new interviews points to `/interviews`.
- [ ] A run stopped at read, record or dead letter prints where and exits 1.
- [ ] A consent or Calendar error prints only the error's fixed message; any other error only its
      name.
- [ ] No application with company domains prints the `jobs domains` hint.
- [ ] `toInterviewCandidates` maps link candidates to detection candidates (active from creation,
      no end, no domains → empty list).
- [ ] AGENTS.md's Commands table has the row, marked Paul-only.
- [ ] `pnpm --filter @northstar/funnel lint typecheck test` pass.

## Failure modes
- Consent refused, timed out or wider than asked: `OAuthError`, nothing read or stored.
- Calendar slow or down: the client's retries, then the `calendar` breaker; the run stops at
  `read`, stores nothing and says rerun later.
- Database down: the command fails before contacting Google (the `select 1` check).
- A refusal the store can't take (too many changes, daily limit): a dead letter, as the run does.

## Observability
- The run's `calendar.detect` span with its counts and `stopped_by`.
- Each stored detection's `interview.detected` event (feed), each dead letter's event.

## Out of scope
- Running on a schedule in the worker: ADR-0026 says continuous detection needs a stored refresh
  token, which is Paul's decision (a `needs:paul` issue).
- Interviews from mail (`interviewFromMail`), prep, reminders.

## Open questions
- None: the orchestrator agreed the home and the scope on #271.

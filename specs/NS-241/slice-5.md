# NS-241 slice 5: `funnel prep`, the command Paul runs to plan and write interview prep

Status: draft
Requirements: CAL-003, CAL-001 (write) · ADR-0002, ADR-0014, ADR-0031, ADR-0007
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/db.md`, ADR-0016
Issue: #275 (slices 1–4 merged: #397, #408, #411, #417)

## Why
Slices 1–4 built every piece of CAL-003's prep flow: stored proposals, the `prep_plan` Gate
request, the write ledger and the Calendar writer. Nothing calls them yet. Paul decided on #400
that Google tokens are never stored, so the flow runs when he runs a command, with consent on
that run. This is that command.

## Behavior
`pnpm --filter @northstar/funnel funnel prep` does five things in one run:

1. **Settings, before Google is asked anything.** It reads Paul's time zone and working hours
   (`loadPrepConfig`, `src/config.ts`):
   - the zone is `PREP_TIME_ZONE`, else `ALERT_TIME_ZONE`, and must be an IANA zone;
   - the hours are `PREP_WORKING_HOURS` as `HH:MM-HH:MM`, default `09:00-17:00`.

   A bad or missing value stops the run, naming the setting and never its value. These settings
   go in `.env.example`'s "Apps" part with placeholders.
2. **Propose.** For each current interview Paul confirmed (`listInterviews`) that has no
   proposal yet (`readPrepProposal`), it calls `proposeInterviewPrep` with the zone, the hours
   and the clock. It passes no busy time in this slice (see Out of scope).
   - An interview that has started, or was replaced by a reschedule, is counted, not an error.
3. **File.** For each confirmed, current interview's proposal it calls
   `requestPrepPlanApproval`, which is idempotent.
   - A new request counts as filed.
   - A replay counts as already waiting. That includes a request Paul withdrew or rejected
     (`replayed: true`, `stored: false`), which means nothing to file.
   - `Superseded`, `NotConfirmed` and `EmptyPlan` are counted.
4. **Write.** Only when something is approved does it ask Calendar write consent
   (`authorizeCalendarWrite`: `calendar.app.created` only, PKCE, the token in memory for this
   run, never stored). For each one it calls `writePrepPlan` with the stored ledger
   (`dbCalendarLedger`), the Gate's ports, and the stored `calendar_writes` kill switch and
   `calendar` breaker.
   - **What counts as approved:** approved `prep_plan` decisions whose undo window has passed,
     not undone, not withdrawn and not yet recorded as written. A new read-only
     `readApprovedPrepPlans` (`packages/db`, `prep-plan-read.ts`) lists them, ids only, newest
     first, at most 50.
   - **Written:** `written` and `already_written` count as written.
   - **Needs Paul:** `scope_missing` counts as needing Paul and stops writing.
   - **Skipped this run, no letter:** `Rescheduled`, `NotApproved`, `InProgress` and `HeldBack`
     are counted. A later run tries again.
   - **Dead letter:** a thrown write failure is a `calendar.prep_write` dead letter (`write_failed`,
     or `claims_exhausted` for `PrepClaimsExhausted`).
     - Its subject is `approval_decision:<decisionId>` and its key is
       `calendar.prep_write:<decisionId>:<n>`.
     - Later runs pass over it unless Paul's newest resolution is Retry (the `funnel inbox` rule,
       `letterState`).
5. **Report.** It prints counts only: proposed, filed, waiting, written, skipped, stuck. Never a
   time, zone, title, calendar id or token.

## Acceptance criteria
- [ ] `runPrep` (ports faked):
  - proposes only for confirmed interviews with no proposal;
  - files proposals and counts replays as waiting;
  - asks consent only when something is approved, and writes each approved plan;
  - maps every `writePrepPlan` answer to its count;
  - letters a thrown write with the right reason and key, and passes over a lettered decision
    unless it was retried.
- [ ] A consent failure, or Google not answering during consent, stops the run with fixed words
      and no letter.
- [ ] `loadPrepConfig` takes the zone from `PREP_TIME_ZONE` or `ALERT_TIME_ZONE` and refuses an
      unknown zone, a missing zone and bad hours, naming the setting only.
- [ ] `readApprovedPrepPlans` (PGlite) lists an effective approval and leaves out:
  - a pending request;
  - a rejection;
  - an approval in its undo window;
  - an undone approval;
  - a withdrawn request;
  - a written decision;
  - another candidate's request.
- [ ] `prepCommand` prints counts and the next step in fixed words.
- [ ] Docs: the AGENTS.md command row and layout note, the README.
- [ ] Checks pass in `@northstar/db` and `@northstar/funnel`.

## Failure modes
- **Google consent refused or timed out:** the run stops after filing; nothing is written, and
  the next run tries again.
- **The `calendar_writes` switch is off, or the `calendar` breaker is open:** `HeldBack` is
  counted, no letter, and later runs try again.
- **A write fails:** the claim stays, and the ledger's lease lets the next run retry it. After
  repeated failures the dead letter shows it on `/health`.
- **The database is down:** the run stops with fixed words.

## Observability
Each step already writes its events: `interview.prep_proposed`, `approval.requested`, the
ledger's `calendar.prep_written` and `dead_letter.recorded`. The writer has its
`calendar.write_prep_plan` span. The command adds no events of its own.

## Out of scope
- **Busy time from Paul's calendar.** Reading it needs a second consent (`calendar.events.readonly`)
  in the same run, so proposals don't avoid his other meetings yet. Paul reviews each plan before
  it is written. This is a follow-up.
- Re-planning after a rejection (needs proposal rounds), reminders (CAL-004), the approval
  card's own view, and a scheduled run (declined on #400).

## Decisions made without Paul
- **funnel → gateways dependency.** `@northstar/funnel` depends on `@northstar/gateways` for
  `writePrepPlan` and `authorizeCalendarWrite`. This is a workspace dependency, pushed by the
  orchestrator. There is no cycle: gateways depends only on db and domain.
- **Settings.** `PREP_TIME_ZONE` falls back to `ALERT_TIME_ZONE`, and `PREP_WORKING_HOURS`
  defaults to 9 to 5.

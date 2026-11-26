# NS-247: Poll new job mail into the mail-link step (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: INB-002, INB-009, INB-011, INB-012 · ADR-0014
Rules that apply: `.claude/rules/tests.md`. Issue #293 (Parent: #224).

## Why
NS-223 slice 1 built `linkNewMessage`, the step that links or queues one new message, but nothing
feeds it. Spam that Gmail delivered also passes its trust check today, so an untagged spam message
could land in Paul's confirm queue as `no_match`. This slice adds the producer and decides spam.
It adds no `packages/db` migration: another agent holds migrations.

## Behavior
- **Spam and trash (item 2).** `linkNewMessage` skips a message labelled `SPAM` or `TRASH` with
  its own reason, `spam`, before anything else is read. Nothing is recorded for it.
- **The producer (item 1).** `pollNewMail(deps, { since })` in `packages/inbox/src/link/poll.ts`:
  - It lists received mail after `since` minus a one-hour overlap. The query leaves out sent mail,
    drafts, spam, trash and chats. It uses the in-memory read-only token, so it reads ids and
    headers only, never a body.
  - It handles messages oldest first, at most 200 a run (`MAX_PER_POLL`).
  - A message goes to the step only if it passes the INB-002 pre-filter (`isJobMail`), or its
    top `Delivered-To` carries one of Paul's known tags (INB-009). Anything else is counted as
    `not_job_mail` and never recorded.
  - It reports counts per outcome, `truncated` when more were listed than it handled, and
    `nextSince`: the receive time of the last message handled, for the caller to keep for its next
    tick. `nextSince` never passes the run's start, so an imported message dated in the future
    can't make later runs pass over real mail.
  - It also reports `nextOverlap`, which is false after a truncated run. The next run then doesn't
    look back an hour: with 200 or more messages in that hour it would list the same oldest 200
    forever.
  - The step records each decision once, so the overlap and a rerun never record twice.
  - A Gmail error on one message's headers, or a failed step, stops the run. The report carries
    the counts so far, `nextSince` before that message, and the message's id (`stoppedAt`, never
    on a span), so nothing after it is skipped.
  - The caller passes back, in `skip`, the ids it has dead-lettered after repeated stops. They are
    passed over (`passedOver`), so one message that always fails can't hold back the mail after
    it.
- **Where `since` comes from.** The caller passes it: a running process keeps `nextSince` between
  ticks. A stored cursor needs a migration and comes in a later slice.
- **Company domains (item 3).** Not decided here: a `needs:paul` issue asks where a company's own
  mail domains come from.

## Acceptance criteria
- [ ] A `SPAM` or `TRASH` message is skipped as `spam`, and nothing is recorded (fake deps).
- [ ] `pollNewMail` builds the windowed query, handles messages oldest first, filters to job mail
  or known tags, calls the step once each, and reports counts and `nextSince` (fake Gmail).
- [ ] More than `MAX_PER_POLL` listed: it handles the oldest 200, sets `truncated`, and
  `nextSince` is the 200th message's time. A second run with `nextOverlap` handles the rest, even
  when all 250 arrived within one hour.
- [ ] A message in `skip` is passed over, and `nextSince` never passes the run's start.
- [ ] A header read that fails stops the run with `nextSince` before that message.
- [ ] On the real write paths (PGlite), the same poll run twice records each message once.
- [ ] The `needs:paul` issue for company domains is filed.

## Failure modes
- Gmail is down or the breaker is open: listing throws `HeldBack` or `GmailError`. Nothing is
  recorded, and the caller retries with the same `since`.
- Mail arrives out of order within the overlap: the hour of overlap re-reads it, and the step
  records it once. Mail Gmail indexes more than an hour after a later message's receive time, or
  right after a truncated run, can be missed. A stored cursor with Gmail's history API is the
  later fix.
- One message fails every time: each run stops at it and names it in `stoppedAt`. The caller
  (#230) records a dead letter after a few ticks and passes it in `skip`.

## Observability
A `mail.poll` span carries the counts and `truncated`, never an address or subject. The step's
own `mail.link` span is unchanged.

## Out of scope
- A stored cursor (needs a migration).
- The worker or CLI that runs the poller on a schedule (#230).
- Company domains (item 3, Paul's decision).
- Classification storage (#224's other follow-ups).

## Open questions
None.

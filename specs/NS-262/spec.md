# NS-262: let Paul link or dismiss a thread in the confirm queue

Status: in progress (autonomous lane, ADR-0016)
Issue: #377 (parent #313)
Requirements: INB-006, INB-009, INB-011
Rules that apply: ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`, `.claude/rules/web.md`,
`.claude/rules/tests.md`

## Why
`matchMail` sends mail it can't place to the confirm queue, and the Inbox tab lists it under "Needs
you to link it", read-only. Nothing lets Paul say which application a thread belongs to, or that it
belongs to none, so the queue only grows.

## Behavior
- **Storage** (`packages/db`, a new migration once the migration lane is free,
  `mail-link-decision-schema.ts`): append-only `mail_link_decision`, one row per queued message:
  `linked` with an application (a foreign key to the candidate's own application), or `dismissed`
  with none. No foreign key to `mail_link` (TRUNCATE, as `recruiter_grade`): the write checks the
  queued row in its transaction.
- **Write** (`mail-link-decision-write.ts`): `decideQueuedThread(db, { candidateId, gmailThreadId,
  decision })`, where `decision` is `{ kind: "link", applicationId }` or `{ kind: "dismiss" }`. The
  queue shows threads, so Paul decides a thread: every queued message in it that has no decision
  yet gets this one.
  - It refuses a thread with no queued message (`NotFound`), and a link to an application that
    isn't Paul's (`UnknownApplication`) or isn't open (`ApplicationClosed`, the statuses
    `readLinkCandidates` reads).
  - A thread whose queued messages are all decided stores nothing (`recorded: 0`), so a repeat
    stores nothing, and a second, different choice doesn't change the first.
  - In the same transaction it writes `mail.link_confirmed` on `application:<id>` (feed: "You
    linked a job email to this application") or `mail.link_dismissed` ("You dismissed a job email
    from the queue"), by `user`, with the thread id, message count and application id only.
  - A confirmed link never moves a status (P1) and is never `senderVerified`: queued mail had no
    authenticated match (INB-011).
- **Reads:**
  - `listConfirmQueue` and the Inbox's queued group leave out decided messages.
  - `readInboxThreads` shows a linked message under its application, with step `paul`.
  - `readLinkedThreads` doesn't count a thread Paul linked (security review): its first sender
    is unknown, and a reply through a shared ATS would pass the thread step as verified. Later mail
    in it waits in the queue again.
  - `readLinkTargets(db, candidateId)` gives the open applications Paul can link to (id, job
    title, company), newest first, at most 200.
- **API** (`apps/api/src/inbox.ts`, session only): `GET /inbox` also answers `linkTargets`, and
  `POST /inbox/decide` takes `{ gmailThreadId, decision: "link" | "dismiss", applicationId? }`.
  It answers `{ recorded }`, `404 not_found`, `409 application_closed`, `404 unknown_application`
  or `503 unavailable`.
- **Web** (`/inbox`): each queued thread gets a choice of open application with Link, and a
  Dismiss button. The answer is shown in words ("Linked", "Dismissed", "Already decided"), then the
  page reloads. A linked thread reads "linked by you".

## Acceptance criteria
- [ ] Link and dismiss store once per message; a repeat stores nothing; a closed, unknown or other
      candidate's application and a thread with nothing queued are refused (PGlite).
- [ ] The queue leaves out decided messages; a linked thread shows under its application with step
      `paul`; `readLinkedThreads` leaves it out (PGlite).
- [ ] The table refuses UPDATE, DELETE, TRUNCATE and bad shapes written directly.
- [ ] The API route's answers (API tests); the web words (unit tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Domain suggestions from confirmed links (#313's next slice).
- Undoing a decision.

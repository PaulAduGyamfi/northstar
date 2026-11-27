# NS-271: Store a final outcome for verification mail the classifier skips

Status: draft
Requirements: INB-003, INB-012, VER-005
Rules that apply: ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/web.md`
Issue: #412 (parent #266)

## Why
`funnel inbox` sorts up to 25 recorded messages a run that have no `mail_classification` row,
newest first (`readUnclassifiedMail`). When `classifyLinkedMail` skips a message as verification
mail (a verification subject, or a code in the body), nothing is stored. So every later run reads
that message's full body again and spends a batch slot on it. With 25 or more of them, older
unsorted mail is held back for good.

## Behavior
- `mail_classification` gets a third outcome, `skipped`: verification mail the classifier left
  alone (INB-012). Such a row has no kind, stage signal, review reason or prompt version, and it
  is decided by `rules`. A CHECK enforces that shape. Verification is the only reason a message is
  skipped, so the row needs no reason column.
- `recordMailClassification` accepts `{ outcome: "skipped", reason: "verification" }` (Zod, strict)
  and stores it once, like any outcome: the first decision stands. Its event is
  `mail.verification_left_alone`, with the message id only. Its feed line is the fixed-word
  reason "Left a verification email alone".
- `funnel inbox` stores that outcome for a skipped message (`storedResult`). It still counts the
  message as `verification`. A refused store becomes a `mail.classify` dead letter
  (`record_refused`), as for any outcome. `readUnclassifiedMail` already leaves out any message
  with a row, so later runs never read it again.
- The Inbox shows a thread whose newest decided message is one of these as
  "Verification email, left alone": `readInboxThreads` gives the kind `verification`, and the
  web app words it. Review rows still give no kind, as before.
- Every other reader ignores the new outcome:
  - the credit report reads only `classified`;
  - the nudge check reads only `classified`;
  - recruiter grading reads only `recruiter_inbound`.
- The code itself is never read, stored, logged or put in an event (VER-005). Only the Gmail id and
  the fixed outcome are kept.

## Acceptance criteria
- [ ] A skipped outcome is stored once, with its event and feed line. A second record stores
      nothing. A skipped outcome with any other field is refused (Zod), and the database refuses a
      `skipped` row with a kind, reason or prompt version (CHECK).
- [ ] `funnel inbox` stores a skipped outcome, and a later run doesn't read that message again.
- [ ] `readUnclassifiedMail` leaves out a skipped message.
- [ ] `readInboxThreads` gives `verification` for a thread whose newest decided message was
      skipped, and the Inbox words it "Verification email, left alone".
- [ ] The credit report and the nudge reader don't count a skipped message.
- [ ] Migration 0105 (after #417's 0104) changes only the CHECK. It is generated on Node 24 by the
      orchestrator (`db:generate`), with the snapshot and journal.
- [ ] Checks pass in `@northstar/db`, `@northstar/funnel` and `@northstar/web`.

## Failure modes
- The store is refused: the message becomes a `mail.classify` dead letter, as before.
- The database is down: the run stops, as before.
- An older row with no outcome for verification mail: none exist, since nothing was stored before.

## Observability
`mail.verification_left_alone` (the message id only), on the existing
`db.mail_classification.record` span with `northstar.mail.outcome = skipped`.

## Out of scope
- Reading or storing the code or link (VER-005; the Verification Catcher owns that).
- Back-filling old skipped messages: the next run stores them as it meets them.

## Open questions
- None.

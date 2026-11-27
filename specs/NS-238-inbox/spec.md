# NS-238 item 1, slice 1: `funnel inbox`, the mail loop's one-shot caller

Status: in progress (autonomous lane, ADR-0016)
Issue: #266 item 1 (parent #118); gives #293's poll its caller
Requirements: INB-002, INB-003, INB-009, INB-012, REC-001 · RES-007
Rules that apply: ADR-0014 (per-run Gmail token), ADR-0002, ADR-0004 (code decides), ADR-0007,
ADR-0016, ADR-0021 (spend cap), `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
The mail-link step, its poller and stored cursor, the classifier and its storage, and recruiter
grading are all built, but nothing runs them. Paul decided on #400: no stored Google token and no
scheduled reading. So the loop runs when he asks, once per run, the way `funnel interviews` reads
the calendar (#405).

## Behavior
`pnpm --filter @northstar/funnel funnel inbox` (Paul only), in one run:
1. Gets `gmail.readonly` consent on this run (`authorizeGmail`): the token stays in memory until the
   process ends and is never stored (ADR-0014).
2. **Links new mail:** `pollFromCursor` over the stored cursor (`readMailCursor` /
   `saveMailCursor`; the very first run starts 7 days back) hands each job message to
   `linkNewMessage`, with Paul's address from Gmail's profile, the open verification windows, his
   tags, open applications with their company domains (`readLinkCandidates`) and the linked
   threads. A run handles at most 200 messages (the poller's own bound); a truncated run says so.
3. **Stuck messages:** when the poll stops at a message, the run tries again (at most 3 polls a
   run). A message that stops it 3 times, for any reason except a held-back call, becomes a dead
   letter (`mail.poll`, reason `read_failed`, key `mail.poll:<gmail id>:<n>`). Later runs pass over
   a message unless Paul's newest resolution of its letters is Retry (an open letter, Skip and Hand
   off keep it out), so one bad message can't hold back the rest; a message that fails again after
   a Retry gets a new letter (`<n>` + 1).
4. **Classifies:** up to 25 recorded messages a run that have no classification, aren't dismissed
   by Paul and aren't passed over for a `mail.classify` letter (the same rule), newest first (`readUnclassifiedMail`). Each is
   read in full (`getFull`, in memory only), run through `classifyLinkedMail` and stored with
   `recordMailClassification`. Queued messages are classified too, not only linked ones, because
   recruiter mail usually matches no application and grading needs its kind. A verification email
   is skipped and never sent to the model. A message whose read or classification throws (other
   than a held-back call or the Claude API not answering) becomes a dead letter (`mail.classify`,
   reason `read_failed`, `classify_failed` or `record_refused`, key `mail.classify:<gmail id>:<n>`). A held-back call or
   the API not answering stops classification for this run; the rest wait for the next.
5. **Recruiter grading:** not in this slice. The `recruiter-extract` route has no enable flag yet,
   and turning it on is out of #266's scope. The run counts the recruiter emails waiting for a
   grade so Paul can see them.
6. **Prints counts only:** listed, linked, queued, skipped, not job mail, passed over, truncated;
   classified by rules and by the model, sent to review, verification skipped, failed; dead
   letters recorded; recruiter emails waiting for a grade. Never a subject, sender, address,
   company or id.

The model runs only behind the existing guards: the `agent:mail-classify` switch, the `anthropic`
breaker and the spend cap (`LLM_DAILY_CAP_USD` / `LLM_MONTHLY_CAP_USD`; `mail-classify` is a `low`
route, so it pauses first). Every Gmail read goes through the `gmail` breaker.

## Acceptance criteria
- [ ] `inboxCommand` prints the counts and exits 0, 1 on a stop or consent error (tests, faked run).
- [ ] The run: polls, retries a stopped poll, dead-letters a message that stops it 3 times (not a
      held-back one), passes over open letters, classifies at most 25, skips verification mail,
      dead-letters a failing message, stops classification on a held-back call (tests, fakes).
- [ ] `readUnclassifiedMail` gives unclassified, undismissed messages newest first, the candidate's
      own only; `readDeadLetterKeys` gives one kind's letters with their resolution (PGlite).
- [ ] The new kinds are on `DEAD_LETTER_KINDS` with words on /health.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Failure modes
- Consent refused or timed out: nothing is read; the command says so and exits 1.
- Gmail down or the `gmail` breaker open: the listing throws, nothing is recorded, and the cursor
  stays where it was.
- Claude API down, switch off or spend cap reached: classification stops; linked mail is kept and
  classified on a later run.
- A message that always fails: a dead letter on /health, and it is passed over until Paul retries.

## Observability
The existing `mail.poll`, `mail.cursor_save`, `llm.call`, `db.mail_classification.record` and
`dead_letter.record` spans and their events (`mail.linked`, `mail.classified`, `mail.needs_review`,
`dead_letter.recorded`). The command's own output is counts only.

## Decisions made without Paul
- The first run reads the last 7 days (not the 9-month backfill, which stays `funnel backfill`).
- Queued (unlinked) messages are classified too; at most 25 classifications a run, newest first.
- Three polls a run before a stuck message is dead-lettered.

## Out of scope
- Grading (needs the route's enable flag and a funnel→sources dependency), status changes from
  mail (`mailStatusChange`), reply drafts, any schedule.

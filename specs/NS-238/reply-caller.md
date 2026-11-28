# NS-238 item 2's caller: `funnel inbox` files reply drafts by grade

Issue: #266 (item 2), parent #118 · Requirements: REC-002, RPL-002 · ADRs: ADR-0002, ADR-0014,
ADR-0016 · Builds on: `recruiterReplyPackage` (#358), `fileReplyDraft` (NS-237), grading in
`funnel inbox` (#415)

## Why
Since #415, `funnel inbox` grades recruiter mail, and since #358 `recruiterReplyPackage` turns a
grade into a reply package. Nothing joins the two yet, so no graded email ever reaches Paul's Queue
as a reply to approve.

## What changes
1. **The setting.** `RECRUITER_REPLIES=on` turns the step on. Unset, empty or `off` leaves it off,
   which is the default. Any other value stops the run before Google is asked anything, naming the
   setting and never its value (`loadRecruiterReplies`, `src/config.ts`). It's a separate loader,
   so `loadFunnelConfig`'s shape and tests stay as they are.
2. **Which emails.** `readReplyCandidates` (`packages/db`, `mail-loop-read.ts`) is read-only and
   returns ids and letters only. It lists recruiter emails that meet all of these:
   - graded (`recruiter_grade`);
   - no `reply_draft` filed for that message (so one filing ever per message, even after Paul
     rejects or edits one);
   - not dismissed by Paul;
   - received in the last 14 days (`REPLY_WINDOW_DAYS`), so turning it on doesn't answer months-old
     mail;
   - Paul's own letter (his newest regrade) is not F. If he hasn't regraded it, the grader's letter
     must not be F.

   They come newest first, each with that letter.
3. **The step** (`runReplies`, `src/reply.ts`, plain code with ports), after grading. For up to 10
   filings a run (`MAX_REPLY`), looking at no more than 30 emails:
   - It skips an email Paul has already answered: a message labelled `SENT` in the same thread,
     received after it. That check is headers only (`threadMessageIds`, `getHeaders`).
   - It reads the email's reply headers (From, Reply-To, Subject, Message-ID, References) with
     `getReplyHeaders`, a new metadata read on the Gmail client. A header that appears twice is
     joined: a second From, Reply-To or Message-ID makes `replyEnvelope` refuse it instead of
     picking one.
   - It builds the package with `recruiterReplyPackage`, using the email's own letter:
     - A/B interested;
     - C "share more";
     - D polite no;
     - F files nothing (`ArchiveSuggested`, counted).
   - It files the package through `fileReplyDraft`.

   The other guards come from code that already exists:
   - The envelope and thread headers come from `replyEnvelope` on the email's own headers.
   - A no-reply recipient is refused.
   - A Reply-To on another domain is flagged, so the Queue's `approve_alone` applies.

   Nothing is sent or written to Gmail.
4. **Fail small.** Failures become a new dead-letter kind, `mail.reply` (in `DEAD_LETTER_KINDS`,
   with words on /health). Reasons:
   - `read_failed`;
   - `invalid_headers` (`InvalidReply`);
   - `no_reply_address`;
   - `file_refused` (the Gate refused it, or the filing threw);
   - `unknown_grade` (a stored letter this code doesn't know).

   Each letter is passed over until Paul retries it, the same rule as `mail.grade`. If Gmail, the
   token or a breaker doesn't answer, the step stops with no letter.
5. **Report.** It prints counts only: filed, already answered, archive suggested, letters, and why
   it stopped. Off, it prints nothing new.
6. **Docs.** The AGENTS.md command row and the `funnel inbox` layout note, `.env.example`, the
   README and `.claude/rules/db.md`.
7. **Dependency.** `@northstar/funnel` depends on `@northstar/profile` (a workspace link; the
   orchestrator approved it and updated the lock), imported only when the step is on.

## Out of scope
- Writing the Gmail draft (`writeReplyDraft`, #230) or sending anything.
- Model-written replies (`draftReply`): the sentences stay fixed (#358).
- Item 4, the agreement measure: it needs Paul's labels.
- Learning from the reply Paul approves or rejects.

## Decisions made without Paul
- **Its own switch, off by default,** separate from `RECRUITER_EXTRACT`, so grading can run
  without filing anything.
- **A 14-day window,** so a first run doesn't file replies to stale mail.
- **F is left out by the reader,** so an archived-suggested email doesn't take a slot on every
  run. Paul's regrade decides the letter when he has given one.
- **"Already answered" means a `SENT` message later in the thread.** A Gmail draft he hasn't sent
  doesn't count.
- **A new dead-letter kind,** `mail.reply`, because these aren't grading failures.
- **A workspace dependency,** `@northstar/funnel` → `@northstar/profile`, for
  `recruiterReplyPackage` (approved by the orchestrator, lock updated by it). Dynamically imported,
  so the other `funnel` commands don't load the profile package.

## Acceptance criteria
- [ ] Off by default: nothing is read and nothing is filed.
- [ ] On: an A, B, C or D email is filed once. A rerun files nothing more.
- [ ] An F, an email Paul answered, a dismissed one and an old one file nothing.
- [ ] Bad headers, a no-reply sender or a Gate refusal each give one `mail.reply` letter, which is
      passed over on the next run.
- [ ] Gmail not answering stops the step with no letter.
- [ ] Duplicate Reply-To headers are joined, so the envelope refuses them, never falls back to From.
- [ ] No migration.

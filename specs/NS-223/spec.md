# NS-223: The mail-link step for one new message (slice 1)

Status: draft (autonomous lane, ADR-0016)
Requirements: INB-009, INB-011, INB-012, VER-007
Rules that apply: ADR-0014 (read-only Gmail, token in memory), ADR-0002, `.claude/rules/inbox.md`
if present, `.claude/rules/db.md`, `.claude/rules/tests.md`. Issue #224 (Parent: #152).

## Why
NS-158 built `matchMail`, the tag store and `recordMailLink`, but nothing runs them on new mail.
This slice adds the step that takes one new job-mail message from "Gmail has it" to "linked or
queued for Paul", and the database read it needs. Producers (a poller) and form filling come later.

## Behavior
- `linkNewMessage(deps, mail)` in `packages/inbox` (`src/link/step.ts`), plain code, headers only:
  1. **Unstamped mail is skipped** (#224 item 3, INB-011):
     - mail whose labels include `SENT` or `DRAFT`;
     - mail whose top `Delivered-To` isn't Paul's own mailbox address, compared with any `+…`
       part removed and, on gmail.com and googlemail.com, dots dropped and googlemail read as
       gmail (Gmail delivers all of those to one mailbox); printable ASCII only (`deps.mailbox`, read once by the caller from Gmail's `users.getProfile`).

     Nothing is stored for skipped mail.
  2. **The Verification Catcher goes first** (INB-012). Mail that matches an open verification
     window (`windowMatches` over the window store's open windows) is skipped, and so is mail
     with a verification subject from any sender (`hasVerificationSubject`, the same subject rule
     triage uses; `isVerificationMail` only covers ATS senders). Nothing is stored for it, so the Catcher keeps it.
  3. **Then `matchMail`** over `readTags`, and over the candidates from `readLinkCandidates`
     plus their linked threads.
  4. **Then `recordMailLink`**, once per message. A repeat stores nothing.

  It returns what happened (`skipped` with a reason, `linked`, `queued`, and whether a row was
  recorded).
- `GmailClient.profileAddress()` reads `users.getProfile`'s `emailAddress`, through the same
  breaker and retries. `MessageHeaders` gains `labelIds`, read from the message's `labelIds`.
- `readLinkCandidates(db, candidateId)` in `packages/db` gives, for each application not in a
  terminal status:
  - its id and creation time;
  - its job's ATS names (from `job_source.ats`).

  It is read-only, with no migration. `packages/inbox` turns each row into a `LinkCandidate`:
  - `atsDomains` from a fixed map of each ATS's sender domains;
  - `activeFrom` is the application's creation time, and `activeUntil` is null (it is open);
  - `companyDomains` is empty and `tenantKey` is null (see Decisions).

## Decisions (recorded in the PR under "Decisions made without Paul")
- **No company domains yet.** The issue warns that a wrong domain links the wrong mail. Nothing
  stores a company's own mail domains yet, and a guess from the apply URL's host would be one.
  So step 3 (sender) never links in this slice: such mail goes to Paul's confirm queue as
  `no_match`. Tags and already-linked threads still link. A follow-up issue covers where domains
  come from.
- **No tenant key.** An application has no stored tenant yet (accounts arrive with NS-142), so
  tenant tags narrow to nothing and queue as `unknown_tag`, as `matchMail` already does.
- **Headers only.** The body is never fetched here. Both cases where the issue allows a body fetch
  (an open window for the sender, or verification-looking headers) are skipped before matching.
- **No labels means no labels.** Gmail leaves an empty label list out of its JSON, so mail with
  none (such as mail a filter archived and marked read) has no `labelIds`. The step treats that as
  delivered mail, since Sent mail and drafts always carry `SENT` or `DRAFT`. `Delivered-To` must
  still be Paul's own address. (The first draft skipped such mail, a silent drop the reviewer
  found. Making the client always return `[]` would have changed an existing test's exact
  assertion, so the step reads a missing list as empty instead.)
- **Callers pre-filter.** The step doesn't run the INB-002 job-mail pre-filter. Its caller (the
  future poller) passes only mail that passed `isJobMail`, or mail to a known tag, so personal mail
  never reaches Paul's confirm queue.
- **A body-only code isn't caught here.** Mail with a verification code only in its body, a
  neutral subject and no open window can still be linked by tag. Only Gmail ids are stored, and
  triage (`classifyLinkedMail`) skips it by its body before anything reads it.
- **`windowMatches` takes headers only** (`verify/catcher.ts`), so the step can ask it before any
  body is fetched. It never read the body. This file wasn't in the plan.

## Acceptance criteria
- [ ] Tagged mail Gmail delivered to Paul's address links to its application and is recorded once
      (a second run records nothing). This is tested with a fake Gmail message and PGlite.
- [ ] Sent and draft mail, and mail whose top `Delivered-To` is another mailbox or missing, are
      skipped, and nothing is stored. Mail with no labels (archived by a filter) still links.
- [ ] Mail matching an open verification window, or with a verification subject from any sender
      (an employer's own domain too), is skipped and nothing is stored.
- [ ] Mail in an already-linked thread links by `thread`. Untagged mail from a new thread queues
      as `no_match`.
- [ ] `readLinkCandidates` leaves out applications in a terminal status and gives each one's ATS
      names.
- [ ] `profileAddress` reads `emailAddress` through the breaker (a fake fetch).
- [ ] `turbo run lint typecheck test build` passes, and the evals replay at baseline.

## Failure modes
- **Gmail slow or down:** `profileAddress` and the header reads throw (or `HeldBack` while the
  breaker is open). The caller retries the message later. Nothing is half-stored, because the
  link row and its event are one transaction.
- **Database down:** the step throws before recording anything.

## Observability
- A `mail.link` span for each message, with its outcome (`skipped:<reason>`, the step, or the
  queue reason). No address, subject or sender goes on it.
- Events: `recordMailLink`'s existing `mail.linked` and `mail.link_queued`.

## Out of scope
- A producer that lists new mail.
- The tagged address on forms (item 2, which waits on NS-227's package caller).
- The credit report's inbox stages (item 4).
- Company domains and tenant keys.
- Fetching the body.

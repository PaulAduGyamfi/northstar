# NS-237 (slice 1): File a checked reply draft with the Gate

Status: done
Requirements: RPL-002 (approve before anything is written), RPL-001 · ADR-0002, ADR-0004, ADR-0017
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #117, issue #263 item 1.

## Why
NS-166 drafts and checks a reply to a job email, but the draft goes nowhere. Paul must see and
approve it before anything reaches Gmail (RPL-002), and what he approves must be exactly what a
later writer puts in the draft: the recipient, subject, thread headers and body.

## Behavior
- **The envelope, by plain code** (`replyEnvelope` in `packages/domain`, `reply-draft.ts`). It is
  built from the incoming message's own headers, never from the model:
  - the recipient is the single bare address of `Reply-To`, else `From`. It is refused unless the
    header holds exactly one plain `local@domain` address, with nothing outside its `<…>` but a
    display name; a quoted name may hold a comma. A bad `Reply-To` is refused, never skipped for
    `From`;
  - the subject is `Re: ` plus the incoming subject, unless that already starts with `Re:`. Control
    characters are refused, and at most 300 characters;
  - `In-Reply-To` is the incoming `Message-ID`, and `References` is the incoming references plus it
    (the newest 20).

  A refusal names the field, never its value.
- **The package** (`ReplyPackage`): the Gmail message id and thread id, the envelope, the body (the
  checked draft's sentences, `replyText`), the ids the draft cites, and the drafter's follow-up
  questions.
  - `replyContentSha256` hashes everything the Gmail writer uses: the message and thread ids, the
    recipient, subject, thread headers and body. That is what Paul approves.
  - `replyToOtherDomain` flags a `Reply-To` on another domain than `From`'s (both are the sender's
    to set). It is stored with the draft for the approval view.
  - Its Gate subject is `email_reply:<uuid>`, a version 8 UUID derived from the Gmail message id
    (the Gate's subjects name a UUID), so one message has one live reply.
- **From a checked draft** (`replyPackage` in `packages/profile`, `reply/package.ts`): it turns a
  `drafted` result plus the incoming headers into a package, or gives the envelope's refusal.
- **Filing** (`fileReplyDraft` in `packages/db`, `reply-write.ts`):
  - It checks the package, then, in one transaction, requests approval (`email_reply`, actor
    `system`, no facts; key `reply:<gmailMessageId>:<sha>`) and stores the draft in the new
    append-only `reply_draft` table, so the queue never holds a reply request with nothing behind
    it.
  - The table's foreign key names the request's id, candidate, kind (`email_reply`) and content
    hash, so a draft can only sit behind the request that pins its exact content.
  - An insert failure becomes a plain error with no cause, since the driver's message would carry
    the body and the address.
  - Filing the same draft again replays the request and stores nothing new.
  - A different draft for a message with one still pending is the Gate's `SubjectAlreadyRequested`.
  - The body, recipient and subject never go into an event or span: `approval.requested` is the
    feed line.

## Acceptance criteria
- [x] The envelope comes from the incoming headers only, each bad header is refused by name, and a
      header naming two addresses is refused.
- [x] A checked draft is filed with the Gate and stored. A rerun replays it, and a different draft
      for the same pending message is refused (PGlite tests).
- [x] No body, recipient or subject in any event or span.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A schema change: the `reply_draft` table and a unique `(id, candidate_id, kind, content_sha256)`
  on `approval_request` for its foreign key.
- The diff is over ~300 lines, about half of it tests.
- The envelope rules above, the UUID derived from the Gmail id for the Gate's subject, and storing the recipient address with the draft, which the writer
  needs.

## Out of scope
- Item 2: the Gmail draft writer, which waits for ADR-0025 and the `gmail.compose` scope.
- Item 3: follow-up nudges.
- Showing the draft in the approval view: the recipient prominently, the `replyToOtherDomain` flag,
  the body and the cited stories and atoms. This must land before the Gmail writer, and Approve
  must be refused for a reply request with no stored draft.
- A caller that runs this from the mail loop (#224 / NS-247).
- Recomputing the recipient and `replyToOtherDomain` inside `fileReplyDraft` from stored inbound
  headers (as NS-213 does for package facts). Today they come from the producer, `replyPackage`,
  and are checked only for shape. The flag is display-only and not hashed, since it follows from
  headers the hash already pins. The writer slice needs this first.

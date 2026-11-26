# NS-237 (slice 1): File a checked reply draft with the Gate

Status: in progress
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
  - the recipient is the single bare address of `Reply-To`, else `From`, refused unless exactly one
    plain `local@domain` address;
  - the subject is `Re: ` plus the incoming subject, unless that already starts with `Re:`. Control
    characters are refused, and at most 300 characters;
  - `In-Reply-To` is the incoming `Message-ID`, and `References` is the incoming references plus it
    (the newest 20).

  A refusal names the field, never its value.
- **The package** (`ReplyPackage`): the Gmail message id and thread id, the envelope, the body (the
  checked draft's sentences, `replyText`), the ids the draft cites, and the drafter's follow-up
  questions.
  - `replyContentSha256` hashes the recipient, subject, thread headers and body: what Paul approves.
  - Its Gate subject is `email_reply:<uuid>`, a version 8 UUID derived from the Gmail message id
    (the Gate's subjects name a UUID), so one message has one live reply.
- **From a checked draft** (`replyPackage` in `packages/profile`, `reply/package.ts`): it turns a
  `drafted` result plus the incoming headers into a package, or gives the envelope's refusal.
- **Filing** (`fileReplyDraft` in `packages/db`, `reply-write.ts`):
  - It checks the package, then requests approval (`email_reply`, actor `system`, no facts; key
    `reply:<gmailMessageId>:<sha>`).
  - It stores the draft in the new append-only `reply_draft` table, against its request.
  - Filing the same draft again replays the request and stores nothing new.
  - A different draft for a message with one still pending is the Gate's `SubjectAlreadyRequested`.
  - The body, recipient and subject never go into an event or span: `approval.requested` is the
    feed line.

## Acceptance criteria
- [ ] The envelope comes from the incoming headers only, and each bad header is refused by name.
- [ ] A checked draft is filed with the Gate and stored. A rerun replays it, and a different draft
      for the same pending message is refused (PGlite tests).
- [ ] No body, recipient or subject in any event or span.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A schema change: the `reply_draft` table.
- The envelope rules above, the UUID derived from the Gmail id for the Gate's subject, and storing the recipient address with the draft, which the writer
  needs.

## Out of scope
- Item 2: the Gmail draft writer, which waits for ADR-0025 and the `gmail.compose` scope.
- Item 3: follow-up nudges.
- Showing the cited stories and atoms in the approval view.
- A caller that runs this from the mail loop (#224 / NS-247).

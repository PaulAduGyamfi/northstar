# NS-237 (slice 2): Show a reply draft in the approval queue, and approve only what is shown

Status: done
Requirements: RPL-002, APR-001…003 · ADR-0002
Rules that apply: ADR-0016, `.claude/rules/web.md`, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #117, issue #263. It meets slice 1's precondition for the Gmail writer.

## Why
Slice 1 files a reply draft with the Gate, but the queue shows only "Email reply" and a subject id.
Paul must see what he approves: who it goes to, whether that differs from the sender's own domain,
the subject and the body. And he must not be able to approve a reply request with nothing behind
it.

## Behavior
- **`missingReplyDrafts(db, candidateId, requestIds)`** (`packages/db`, `reply-write.ts`): the ids
  among them that are the candidate's `email_reply` requests with no stored `reply_draft`.
- **API** (`apps/api/src/approvals.ts`, session only):
  - `GET /approvals/reply?requestId=<uuid>` gives the draft behind a request: `to`,
    `replyToOtherDomain`, `subject`, `body`, `cites`, `followUps`. It is 404 when there is none, or
    the request isn't the candidate's.
  - In `POST /approvals/decide`, an approve of an `email_reply` request with no stored draft is
    never decided: its outcome is `missing_draft`. A reject still goes through, so Paul can clear
    one.
- **Web** (`/approvals`): each "Email reply" item has a "Show the reply" button. It fetches the draft
  and shows:
  - `To:` with the address;
  - a warning line when the reply goes to another domain than the sender's;
  - the subject, the body, the follow-up questions and how many stories and atoms it cites.

  The batch summary says when an approve was refused for a missing draft. Text is shown as plain
  text, never as HTML.

## Acceptance criteria
- [x] `missingReplyDrafts` finds only the candidate's `email_reply` requests with no draft (PGlite).
- [x] The reply endpoint gives the stored draft, and 404 for none (fakes).
- [x] An approve of a reply with no draft is `missing_draft` and never decided; a reject is decided.
- [x] The page's lines for a reply include the warning only when flagged; the summary words cover
      `missing_draft`.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A reject of an empty reply request stays allowed, so it can be cleared from the queue.

## Out of scope
- The Gmail draft writer (ADR-0025), recomputing the envelope from stored headers, follow-up nudges.

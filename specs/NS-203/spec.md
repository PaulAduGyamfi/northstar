# NS-203: Edit a waiting item in the approval queue before approving it

Status: slice 1 in progress (autonomous lane, ADR-0016)
Requirements: APR-002 (inline edit), APR-001, RPL-002
Rules that apply: ADR-0002, ADR-0017 (one subject is one send), ADR-0004, `.claude/rules/db.md`,
`.claude/rules/tests.md`.
Issue #179 (Parent: #68). Blocked by NS-140 (#69), which is closed: the withdraw record exists.

## Why
The Queue lets Paul approve, reject and undo, but not change an item first. A reply draft that is
nearly right has to be rejected and drafted again. Paul should be able to fix the wording and then
approve exactly what he wrote.

## Behavior (slice 1: reply drafts)
- **`editRequest`** (`packages/db`, `approval-write.ts`) is the Gate's edit, in one transaction:
  - It refuses a request that isn't the candidate's (`NotFound`), and one that is no longer
    pending: decided, withdrawn or already edited (`NotPending`). It refuses an
    `application_package` or `vault_reveal` request (`NotEditable`): packages need their facts
    derived again, which is a later slice.
  - It refuses new content with the same SHA-256 (`ContentUnchanged`).
  - It withdraws the old request by `user` (reason `paul`). The `approval.withdrawn` event carries
    `edited: true`, so the feed says "You edited a request; the edited version is waiting for your
    approval".
  - It files a new request with the same kind and subject, the new content's SHA-256, actor `user`
    and the key `edit:<old request id>`. A reply is never auto-approved, so it waits for Paul.
  - It stores an append-only link in the new table `approval_edit`: one row per old request
    (unique), one per new request (unique), both the candidate's (composite foreign keys).
  - If Paul's decision on the old request commits while the edit runs, the whole edit rolls back
    with `NotPending`.
- **`editReplyDraft`** (`packages/db`, `reply-write.ts`) edits a stored reply's body. It keeps the
  recipient, subject, thread headers, cites and follow-ups, hashes the new package with
  `replyContentSha256`, calls `editRequest` and stores the new `reply_draft`, all in one
  transaction. The body must be 1–5,000 characters, not blank, with no control character other
  than a line break (`\r\n` becomes `\n`). Paul's own words are not checked against citations:
  ADR-0004 covers what the model drafts, and Paul approves the edited text as his.
- **The API:** `POST /approvals/edit-reply` (session only), with `{ requestId, body }`. It answers
  with the new request's id, 404 for an unknown request, 409 when it isn't pending or the body is
  unchanged, and 400 for a bad body.

## Acceptance criteria
- [ ] After an edit, approving the old request is refused, and the new request's hash matches the
      edited content (`replyContentSha256` of the stored draft).
- [ ] The edit shows in the feed (`approval.withdrawn` with `edited`, then `approval.requested`),
      and so does the approval that follows.
- [ ] Editing the same request twice, or a decided or withdrawn one, is refused and stores nothing.
- [ ] Another candidate's request is `NotFound`.
- [ ] `approval_edit` refuses UPDATE, DELETE and TRUNCATE.
- [ ] The endpoint answers 401 without a session.
- [ ] `pnpm turbo run lint typecheck test build` passes in the touched packages.

## Failure modes
- Paul decides on the old request while the edit runs: the edit rolls back (`NotPending`) and
  nothing is stored. The Queue shows his decision.
- Two edits of the same request at once: one commits. The other hits the withdrawal's or the
  link's unique constraint and is `NotPending`.

## Observability
- `approval.withdrawn` (with `edited: true`) and `approval.requested`, from the Gate's own paths.
  Ids and codes only, never the body.
- Span `approval.edit` with the request kind.

## Out of scope
- The web app's Edit action in "Show the reply" (slice 2).
- Editing application packages and banked answers (a later slice): edited answers must count as
  `new` for the Gate's policy.

## Open questions
- Should an edited reply keep its cites? Slice 1 keeps them as the record of what the draft cited.
  The Queue still says how many items it cites.

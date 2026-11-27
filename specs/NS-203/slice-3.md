# NS-203 slice 3: mark an edited request "Edited by you" in the Queue

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #179 (parent #68); slices 1 (#324) and 2 (#347) came first.
Requirements: APR-002 · ADR-0002, ADR-0017
Rules that apply: `.claude/rules/db.md`, `.claude/rules/web.md`, `.claude/rules/tests.md`

## Why
After Paul edits a waiting reply, the Queue shows the edited request like any other, and its reply
view still says "It cites N of your stories or atoms", although the body he wrote may no longer be
what those cites back. Slice 2 left the mark out because the API didn't say which requests are
edits.

## Behavior
- `listPendingApprovals` (`packages/db`) gives each waiting request `edited: true` when it replaced
  one Paul edited (a row in `approval_edit` names it as the new request), else `false`. Read-only;
  no migration.
- The API's `GET /approvals` passes `edited` through, field by field.
- The web app's Queue (`src/approvals.ts`, `approval-queue.tsx`): an edited item reads "Edited by
  you" next to its subject, and its "Show the reply" view says "Edited by you: you changed this
  reply's text after it was drafted." in place of the cites line (`replyLines(reply, edited)`).

## Acceptance criteria
- [x] `listPendingApprovals` marks only a request that replaced an edited one (PGlite test).
- [x] `GET /approvals` returns `edited` for each item.
- [x] The Queue's words: the item's mark and the reply view's line for an edited request; the cites
      line unchanged for one that wasn't edited.
- [x] lint, typecheck, test and build green for db, api and web; docs updated.

## Out of scope
- Editing application packages and banked answers (their facts must be derived again).

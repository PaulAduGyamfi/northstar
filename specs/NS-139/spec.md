# NS-139: The approval queue in the app (slice 1)

Status: built, in review (autonomous lane, ADR-0016)
Requirements: APR-001, APR-002 (batch, reject with reason), APR-003 (mobile-friendly); APR-002
inline edit and APR-003 push approve follow up
Rules that apply: ADR-0002, ADR-0017, ADR-0018; `.claude/rules/web.md`, `db.md`, `tests.md`

## Why
NS-119 built the Approval Gate's core: requests, policies, batch decisions, undo and
`verifyApproval`. Nothing in the app lets Paul see what's waiting or decide it. Approval is the
one thing that lets anything go out under his name (ADR-0002), so he needs one queue he can work
from his laptop or phone. Only his signed-in path may decide.

## Behavior
1. **API** (`apps/api`, `approvals.ts`, every endpoint `auth: "session"`):
   - `GET /approvals?kind=`: the pending queue, oldest first (`listPendingApprovals`): request id,
     kind, subject, requested time.
   - `POST /approvals/decide { requestIds, decision, reason? }`: approve or reject one or many
     (`decideApprovals`). Each id gets its own outcome: `approved`/`rejected` with the decision id
     and `effectiveAt`, or `not_found`/`already_decided`. A rejection without a reason is a 400.
     At most 100 ids per call.
   - `POST /approvals/undo { decisionId }`: takes a decision back inside its undo window
     (`undoDecision`): 200, or 404 / 409 with the reason (`already_undone`,
     `undo_window_closed`, `subject_reopened`).
   - These are the only callers of `decideApprovals` and `undoDecision`, so every decision is
     Paul's (`decided_by = 'user'`). The body never names the decider.
2. **Web** (`apps/web`, `/approvals`, behind `readApi`; a nav link):
   - The queue as a list that reads well on a phone: kind in words, subject, how long it has
     waited.
   - Select items, "Approve selected" and "Approve all", "Reject…" with a required reason.
   - After a decision, an undo bar counts down to `effectiveAt` (the 2-minute window) and stops
     when it passes. Its time comes from the API's `effectiveAt`, never the browser's own clock
     alone.
   - Plain logic in `src/approvals.ts` (schemas, kind words, the countdown, the batch's outcome
     summary), tested without a browser.

## Acceptance criteria
- [x] Every endpoint refuses a request without a session (401) and the extension token.
- [x] `POST /approvals/decide` passes Paul's ids, decision and reason through as given, and
      reports each id's outcome; a rejection without a reason is 400 and decides nothing; more than
      100 ids is 400.
- [x] `POST /approvals/undo` maps each Gate refusal to its status and code.
- [x] Decisions made through the API are recorded `decided_by = 'user'` (a test on the real write
      path).
- [x] The countdown reads from `effectiveAt` and reaches zero exactly at it (web test).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green (CI on the PR).

## Failure modes
- **Postgres down:** `GET /approvals` answers 503 and the page says the queue can't be read; a
  decide or undo answers 500 and the page says nothing was decided.
- **Two tabs decide the same item:** the Gate serialises them; the second gets `already_decided`.
- **The undo window passed while the bar showed:** the API answers `undo_window_closed` and the
  page says so.

## Observability
The Gate already writes `approval.decided` and `approval.undone` with feed lines, and the API adds
its `api.request` span per call. No new events.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #68`)
- APR-002 inline edit: an edit is a new subject (ADR-0017), so it needs the withdraw record
  planned in NS-140 (#69).
- APR-003 push approve: a push that approves a batch from the phone's notification.
- Showing what each item contains (the package, answer or draft). There is nothing stored to show
  until NS-161 (#112) and the other producers land; the subject is shown instead.

## Open questions
- Is 100 ids per batch the right cap? It keeps one request bounded; "Approve all" over a longer
  queue sends several.

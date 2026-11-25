# NS-140: Gate hardening, slice 1: the withdraw record

Status: accepted (autonomous lane, ADR-0016)
Requirements: APR-004 · ADR-0002, ADR-0017
Rules that apply: ADR-0002, ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`
Parent: #18 (NS-119)

## Why
An approved request stays approved forever, and a subject can be requested at most once while a
request for it is pending or approved. When the content changes for good (Paul edits the cover
letter after approving), or Paul changes his mind about something still waiting, there is no way
to close the request, so the subject can never be asked about again.

## Behavior
1. **`approval_withdrawal`** (append-only, one per request, `packages/db`): who withdrew it
   (`user` for Paul, `gateway`), why (`paul`, `content_changed`), and when (the Gate's database
   clock, `northstar_gate_now()`).
2. **`withdrawApproval(db, { candidateId, requestId, by, newContentSha256? })`** (the only writer):
   - Paul (`by: "user"`) may withdraw a request that is pending or approved.
   - A gateway (`by: "gateway"`) may withdraw only an approved request, and only by passing the
     SHA-256 of the content it now holds, which must differ from the approved one
     (`content_changed`, proven in code, not asserted).
   - A rejected request is already closed: refused (`AlreadyClosed`). A second withdrawal: refused.
   - One `approval.withdrawn` event with ids, who and why (never content).
3. **A withdrawn request is closed everywhere**, in the SQL guards and in code:
   - `verifyApproval` refuses its decision (`Withdrawn`), and the vault won't open under it.
   - It leaves the pending queue; a decision on it, or an undo of its decision, is refused.
   - Its subject may be requested again. A request after Paul's withdrawal always waits for him
     (like after a rejection or undo); after a gateway's `content_changed` the policies run as usual.
   - The withdrawal locks the request and its decision rows, as an undo does, so a gateway's
     `verifyApproval` and a withdrawal never overlap.

## Acceptance criteria
- [ ] Paul withdraws a pending request: it leaves the queue, its subject can be requested again.
- [ ] Paul withdraws an approved request: `verifyApproval` returns `Withdrawn`; the vault refuses it.
- [ ] A gateway withdrawal with the same content hash is refused; with a different one it closes
      the approval and a new request for the subject may be auto-approved by policy.
- [ ] After Paul's withdrawal, a new request for the subject waits for him even if a rule matches.
- [ ] A rejected request can't be withdrawn; a request can't be withdrawn twice; a withdrawn
      request can't be decided or have its decision undone (in code and in the database).
- [ ] The withdrawal table refuses UPDATE, DELETE and TRUNCATE; its time comes from the Gate clock.

## Failure modes
A race between a withdrawal and a decision, undo or verify is serialized by row locks and the
subject's advisory lock (as migration 0016 does); the loser gets a named refusal.

## Observability
`approval.withdrawn` event (requestId, decisionId or null, by, reason) with a feed line, and an
`approval.withdraw` span with the outcome.

## Out of scope (follow-up issues)
- The Apply Gateway calling `withdrawApproval` on a permanent `ContentChanged` (packages/gateways).
- Items 2–4 of #69: derived policy facts (the registries don't exist yet), a non-owner database
  role (a credential and deployment decision for Paul), and signalling waiting workflows (no
  Temporal workflow exists yet).
- A CLI or UI for Paul to withdraw.

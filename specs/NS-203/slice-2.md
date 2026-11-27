# NS-203 slice 2: the Queue's Edit button for a waiting reply

Status: in progress (autonomous lane, ADR-0016)
Requirements: APR-002 · ADR-0017, ADR-0002
Rules that apply: `.claude/rules/web.md`, `.claude/rules/tests.md`.
Issue #179. Slice 1: #324 (`editReplyDraft`, `POST /approvals/edit-reply`).

## Behavior
- "Show the reply" on an `email_reply` item gains **Edit**. It opens the body in a textarea; the
  recipient, subject and cited items are not editable (slice 1 keeps them).
- **Save the edit** checks with `editProblem` first (not blank, at most `MAX_REPLY_BODY` = the
  API's 10,000, different from the original) and sends nothing on a problem. Then it calls
  `POST /api/approvals/edit-reply` and says the answer with `editResultWords`:
  - 200: "Saved. Your edited version is waiting for your approval.";
  - `409 not_pending` (a double-click after the first save, or a decision meanwhile): read as
    done, not failed;
  - other refusals and failures in plain words.

  On 200 or `not_pending` the Queue reloads, showing the edited request in place of the old.
- No API, database or migration change.

## Acceptance criteria
- [ ] `editProblem` refuses a blank, too long or unchanged body.
- [ ] `editResultWords` covers 200, 401, `not_pending`, `unchanged`, `not_found`, 5xx and unknown.
- [ ] AGENTS.md describes the button.

## Out of scope
An "edited by you" mark on the edited request (the API doesn't say a request is an edit yet), and
editing application packages and banked answers.

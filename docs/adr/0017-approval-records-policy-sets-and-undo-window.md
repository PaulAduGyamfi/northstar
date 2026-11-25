# ADR-0017 — Approval records, policy sets and a 2-minute undo window

**Status:** Accepted (agent, under ADR-0016) · **Date:** 2026-11-25

## Context
ADR-0002 puts a deterministic Approval Gate between agents and every outbound action: gateways
refuse any call without an `approvalId` or `policyDecisionId` they verify against the Gate.
APR-004 says approval records are immutable and referenced by the action they authorize. APR-002
asks for batch approve and reject with a reason; UX-016 and the design research brief ask for an
undo window ("~2 min undo send") rather than confirmation dialogs. NS-119 is the first code that
stores approvals, so it fixes their shape for every gateway that follows. This record implements
ADR-0002; it doesn't amend it.

## Decision
1. **Four append-only tables** in `packages/db` (`approval-schema.ts`): `approval_request`,
   `approval_policy_set`, `approval_decision`, `approval_undo`. A trigger refuses UPDATE, DELETE
   and TRUNCATE on all four (migration `0016_approval_append_only.sql`). A request's state is
   derived: pending while it has no **live** decision (a decision with no undo).
2. **The decision id is the authorization.** A gateway carries `approval_decision.id`: an
   `approvalId` when `decided_by = 'user'`, a `policyDecisionId` when `decided_by = 'policy'`.
   `verifyApproval` (in `approval-write.ts`) looks it up server-side and passes it only if it is
   live, approves, is past its undo window, and matches the kind and subject the gateway is about
   to act on. Anything else is a named refusal, so gateways fail closed.
3. **At most one live decision per request**, enforced in the database: an insert trigger locks
   the request row and refuses a second live decision.
4. **Undo window: 2 minutes** (`UNDO_WINDOW_MS` in `packages/domain`). Every decision stores
   `effective_at = decided_at + 2 min`. Until then Paul can undo it (an `approval_undo` row; a
   trigger refuses one after `effective_at`), and the request goes back to pending. Policy
   auto-approvals get the same window.
5. **Policies are whole sets.** Saving rules writes a new `approval_policy_set` row; the newest
   (highest `version`) is in force, older ones stay so each policy decision shows the exact rules
   it used. No set, or an empty one, means everything waits for Paul.
6. **Only application packages can be auto-approved.** The rule schema (`PolicyRule` in
   `packages/domain`) has `kind: "application_package"` only, and a known adapter plus a form
   seen before are always required (APPLY-003). Answers, email replies, outreach, profile PRs and
   plans always wait for Paul (ANS-005, RPL-002, OUT-005).
7. **What stays out of events and spans:** reject reasons and any draft text. Events carry ids,
   kinds, the subject aggregate and counts.

## Alternatives considered
- **A mutable `status` column on the request:** simpler queries, but it breaks APR-004 and makes
  "who approved this, and was it undone?" a matter of trusting the last writer.
- **Undo by deleting the decision:** loses the audit trail; an undo row keeps it.
- **Per-rule rows with enable/disable flags:** needs updates (not append-only) and makes "which
  rules were in force at 12:03?" a reconstruction. Whole sets answer it with one id.
- **No undo window for policy decisions:** auto-submit would be instant and irreversible; the
  research brief's undo window exists for exactly that case.

## Consequences
- + "Nothing goes out without approval" is one function every gateway calls, with a test for
  each refusal.
- + A full audit trail per request: who asked, which rule or Paul decided, when it took effect,
  any undo.
- − Every gateway action waits at least 2 minutes after approval. Gateways (NS-120 onward) must
  call `verifyApproval` at the moment they act, not when they enqueue, and schedule the action
  for `effective_at`.
- − The window length is a constant; making it a per-kind setting later needs a code change, not
  a migration (`effective_at` is stored per decision).
- Open question for Paul: the 2-minute length and the undo on policy decisions are inferred from
  the research brief.

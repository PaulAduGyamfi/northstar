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
2. **The decision id is the authorization, bound to the content.** A gateway carries
   `approval_decision.id`: an `approvalId` when `decided_by = 'user'`, a `policyDecisionId` when
   `decided_by = 'policy'`. Every request stores the SHA-256 of exactly what Paul is asked to
   approve (`content_sha256`). `verifyApproval` (in `approval-write.ts`) looks the id up
   server-side and passes it only if it is live, approves, is past its undo window, and matches
   the kind, subject **and content hash** of what the gateway is about to send. Anything else is
   a named refusal (`ContentChanged` among them), so gateways fail closed. `verifyApproval` can be
   called any number of times: a gateway's idempotency key must come from the decision id, so one
   approval means one send.
3. **At most one live decision per request**, enforced in the database: an insert trigger locks
   the request row and refuses a second live decision.
4. **Undo window: 2 minutes** (`UNDO_WINDOW_MS` in `packages/domain`, the same interval in the
   decision trigger; a test checks they agree). Every decision stores
   `effective_at = decided_at + 2 min`. Until then Paul can undo it (an `approval_undo` row; a
   trigger refuses one after `effective_at`), and the request goes back to pending. Policy
   auto-approvals get the same window. Emptying the policy set doesn't revoke an auto-approval
   already in its window; Paul undoes that one himself.
5. **One clock: the database's.** No Gate function takes a time. Triggers stamp `requested_at`,
   `decided_at`, `effective_at`, `undone_at` and `created_at` from `northstar_gate_now()`, and
   `verifyApproval` compares `effective_at` with it in SQL, so a gateway or UI clock that runs fast
   or slow can't shorten the window or record an undo after an action went out. In production the
   function is plain `clock_timestamp()` with no override; only the PGlite test database replaces
   it with one pinned by the session setting `northstar.gate_test_now`. `verifyApproval` and the
   undo trigger lock the same decision row, so an undo at the edge of the window and a gateway's
   check never overlap. The Gate's checks assume READ COMMITTED (the default isolation level).
6. **One open request per subject.** A new request for a subject is refused
   (`SubjectAlreadyRequested`, and a trigger as backstop) while an earlier one is pending or
   approved. After Paul rejects it, a new request (e.g. with edited content) is allowed, but a
   subject Paul ever rejected or undid can never be approved by a policy again: asking again must
   not route around him. Undoing an old rejection is refused (`SubjectReopened`) while another
   request for the subject is open, so the queue never holds two requests for one subject.
   **A subject is one send:** one application package, one email draft, one outreach message,
   not a job or a thread. A new version is a new subject. An approved subject stays approved for
   good, so a gateway that gets `ContentChanged` must turn it into a `needs_human` item (ADR-0007),
   never retry it silently. A "withdrawn" record that closes an approved request is a follow-up.
7. **Policies are whole sets.** Saving rules writes a new `approval_policy_set` row; the newest
   (highest `version`) is in force, older ones stay so each policy decision shows the exact rules
   it used. No set, or an empty one, means everything waits for Paul. Stored rules are parsed
   again when read; a set that no longer parses counts as no rules.
8. **Only application packages can be auto-approved.** The rule schema (`PolicyRule` in
   `packages/domain`) has `kind: "application_package"` only, and a known adapter plus a form
   seen before are always required (APPLY-003). Answers, email replies, outreach, profile PRs and
   plans always wait for Paul (ANS-005, RPL-002, OUT-005). The decision trigger refuses a policy
   decision on any other kind too.
9. **What stays out of events and spans:** reject reasons and any draft text. Events carry ids,
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
- − Policy facts (fit, adapter, form seen before, answer sources) are what the producer says.
  Only plain-code workflow activities may pass them, never an agent that read untrusted text;
  later the Gate should derive them from stored records itself.
- − The triggers can be disabled by the table owner (as for `domain_event`). Running the app as a
  non-owner role with INSERT/SELECT only on `approval_*` is the later fix.
- Open question for Paul: the 2-minute length and the undo on policy decisions are inferred from
  the research brief.

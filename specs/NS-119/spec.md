# NS-119: Approval Gate, policies, batch approve, undo window

Status: agent-approved under ADR-0016 (Paul reviews after merge; see the PR's "Decisions made
without Paul")
Requirements: APR-001 (one queue), APR-002 (batch approve, reject with reason; inline edit
deferred), APR-004 (immutable records referenced by the action), ADR-0002 (the Gate and its
policies). APR-003 (mobile, push approve) is deferred: no app exists yet.
Rules that apply: ADR-0002, ADR-0012 (append-only log), ADR-0007,
[ADR-0017](../../docs/adr/0017-approval-records-policy-sets-and-undo-window.md) (new, this ticket),
`.claude/rules/db.md`, `gateways.md` (the verify contract), `tests.md`

## Why
"A human approves anything that goes out under Paul's name" is the product's first rule, and
ADR-0002 says it must be enforced in code, not by an "are you sure?" dialog. Nothing in the repo
records an approval yet, so no gateway (NS-120 onward) has anything to check. This ticket builds
the Gate: the queue of things waiting for Paul, his decisions as immutable records, the
auto-approve policies he controls, and a short undo window before any approval takes effect.

## Behavior

### Approval requests (APR-001)
- Any producer (a workflow, later) calls `requestApproval` with a **kind**, a **subject** (the
  thing to approve, as an aggregate `application:<uuid>`), the **SHA-256 of the content** to
  approve, the **facts** a policy may look at, the actor, and an idempotency key. Kinds are the APR-001 list: `application_package`,
  `answer`, `email_reply`, `outreach`, `profile_fix`, `growth_plan`, `prep_plan`.
- The same idempotency key twice returns the first request and writes nothing new.
- A subject that is already pending or approved can't be requested again
  (`SubjectAlreadyRequested`). After Paul rejects it, it may be requested again (edited
  content), and then it always waits for him: a subject Paul rejected or undid is never
  auto-approved. Undoing the old rejection while the new request is open is refused
  (`SubjectReopened`). A subject is one send (one package, one draft), not a job or thread.
- `listPendingApprovals` returns every request with no live decision, oldest first (one queue for
  every kind), optionally filtered by kind.

### Auto-approve policies (ADR-0002 item 2, APPLY-004)
- Paul's policies are a **policy set**: a list of rules saved as one immutable row. A new set
  replaces the old one; the old row stays for the audit trail. No set, or an empty set, means
  **everything waits for Paul** (ADR-0002 default, Q-07).
- A rule applies to `application_package` only and auto-approves when **all** its conditions
  hold: fit score ≥ `minFit`; a known ATS adapter (not the generic one); the form shape was seen
  before (APPLY-003: first-time forms always need Paul); every answer reused from the bank
  (`bank_exact`, or also `bank_high_confidence` if the rule allows it); no free-text answer longer
  than `maxFreeTextWords`.
- A missing fact (no fit score yet) never auto-approves.
- Every other kind (new answers, email replies, outreach, profile PRs, plans) can never be
  auto-approved: the policy schema refuses a rule for them (ANS-005, RPL-002, OUT-005).
- The evaluator is plain code, no model. It returns the matched rule, or for each rule the
  conditions that failed, so the feed can say why something waited.

### Decisions (APR-002, APR-004)
- `decideApprovals` takes one or many request ids (batch: "approve all" is the pending list's
  ids) and `approve` or `reject`. Each request gets its own outcome; one bad id never sinks the
  batch. Rejecting needs a reason (it feeds learning later).
- A decision is an immutable row: who decided (`user` or `policy`, with the policy set and rule
  name), when, and when it takes effect.
- A request has at most one live decision. Deciding a request that already has one reports
  `AlreadyDecided` and changes nothing.

### Undo window (UX-016, design research brief)
- Every decision takes effect 2 minutes after it is made (`effective_at`). All Gate times come
  from the database clock (`northstar_gate_now()`), never from a caller. Until then
  `undoDecision` records an immutable undo; the request goes back to pending and can be decided
  again. After `effective_at`, undo is refused (`UndoWindowClosed`).
- Policy auto-approvals get the same window, so Paul can stop an auto-submit.

### Verification for gateways (ADR-0002 item 3, APR-004)
- `verifyApproval(db, { candidateId, decisionId, kind, subject, contentSha256 })` is what every
  gateway will call with the `approvalId` / `policyDecisionId` it was given. It looks the
  decision up server-side and returns it only if it exists for this candidate, approves, has not
  been undone, is past its undo window by the database clock, and matches the kind, subject and
  content hash the gateway is about to send. Otherwise it returns a named refusal (`NotFound`,
  `Rejected`, `Undone`, `UndoWindowOpen`, `SubjectMismatch`, `ContentChanged`).

### Immutable records
- `approval_request`, `approval_policy_set`, `approval_decision` and `approval_undo` are
  append-only: a trigger refuses UPDATE, DELETE and TRUNCATE (like `domain_event`).

## Acceptance criteria
- [ ] The policy evaluator auto-approves only when every condition of a rule holds, and names
      the failed conditions otherwise (tests, one per condition).
- [ ] With no policy set, or an empty one, every request waits for Paul (test).
- [ ] The policy schema refuses a rule for any kind other than `application_package` (test).
- [ ] Requesting twice with the same key stores one request and one event (test).
- [ ] A request matching a policy gets a `policy` decision citing the set and rule (test).
- [ ] Batch approve of N pending requests returns N outcomes; an unknown id in the batch is its
      own `NotFound` and the others still succeed (test).
- [ ] Reject without a reason is refused; with one it is stored (tests).
- [ ] A decided request can't be decided again (`AlreadyDecided`, test).
- [ ] Undo inside the window returns the request to pending; after it, `UndoWindowClosed`
      (tests, injected clock).
- [ ] A pending or approved subject can't be requested again; a rejected or undone one is never
      auto-approved (tests).
- [ ] A caller's times are ignored: triggers stamp every record from the database clock (test).
- [ ] `verifyApproval` refuses a content hash that differs from the approved one (test).
- [ ] `verifyApproval` refuses each case above with its named error and accepts a live,
      effective approval of the same kind and subject (tests).
- [ ] UPDATE and DELETE on each of the four tables fail with `restrict_violation` (tests).
- [ ] Events `approval.requested`, `approval.decided`, `approval.undone` carry ids, kind and
      counts only: no reject reason, no draft text (test).
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- **Database down:** every Gate call throws before writing; nothing is approved by default. A
  gateway that can't verify refuses (fail closed).
- **Two approvals racing for one request:** the request row is locked for the decision, so one
  wins and the other gets `AlreadyDecided`.
- **Clock skew between Gate, gateway and UI:** none matters. Every time is the database's, and
  the undo window is judged in SQL against the same clock.
- **A policy set saved with a bad rule:** refused by the schema before anything is written.

## Observability
- Events: `approval.requested` (kind, subject aggregate), `approval.decided` (decision,
  decided_by, rule name when a policy decided, effective_at), `approval.undone`.
  `approval.policies_set` (rule count).
- Spans: `approval.request`, `approval.decide`, `approval.undo`, `approval.verify`, each with
  kind and outcome attributes, never reasons or text.

## Out of scope
- **Inline edit** (APR-002): the things being edited (packages, answers, drafts) arrive with
  NS-117, NS-118 and later. Follow-up issue.
- **Mobile / push approve** (APR-003) and the queue UI: need the web app. Follow-up issue.
- **Signalling waiting Temporal workflows:** no worker exists yet; gateways verify by reading
  the Gate. Follow-up with the first workflow.
- **Gateways themselves** (NS-120 and later): they call `verifyApproval`.
- A CLI for Paul: nothing produces requests yet, so there would be nothing to approve.

## Open questions
1. The 2-minute undo window is from the design research brief (~2 min "undo send"); confirm.
2. Undo applies to policy auto-approvals too (so Paul can stop an auto-submit). Inferred.
3. Policy conditions are the APPLY-004 example; the rule language may grow when fit scoring
   (NS-116) and the answer bank (NS-118) land.

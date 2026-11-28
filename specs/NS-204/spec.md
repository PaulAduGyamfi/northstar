# NS-204: approve from a push notification on Paul's phone

Status: in progress (autonomous lane, ADR-0016)
Issue: #180 (parent #68) · Requirements: APR-003 · ADR-0002, ADR-0032; decision on #162
Rules that apply: `.claude/rules/web.md`, `.claude/rules/db.md` and `.claude/rules/worker.md`

## The rule this is built around
A push alone never approves anything (decision on #162, the orchestrator's assignment):
- The notification carries a request id and a kind code, and nothing else. It never carries a
  subject, company, title or draft text.
- Tapping it opens that request in the Queue.
- Approving is still Paul's tap on "Approve" in the app, through the session-only
  `POST /approvals/decide`. The undo window applies as it does today.
- No token or approval capability goes into the payload or the service worker.

The notification has **no approve action button**. A lock-screen "Approve" would approve
something Paul hasn't seen; opening the item first costs one extra tap.

## Slices
1. **This PR, no migration:**
   - **The payload and its words:** `ApprovalPush` in `packages/domain` (`push-payload.ts`): `{ v: 1, kind: "approval", id, request }`, where `request` is a kind code from the Queue's own kinds (`vault_reveal` is never one). `pushWords` words it with a fixed sentence per kind.
   - **The service worker:** `apps/web/public/sw.js` shows those words. A tap opens `/approvals?request=<id>`, built from a validated UUID only, never from a URL in the push.
   - **The Queue:** given a waiting request's id in `?request=`, the Queue marks that item and selects it, so one tap on "Approve selected" approves it. If the request isn't waiting any more, it says so. Any other value is ignored.
2. **Slice 2 (migration 0110):** the sender.
   - A `push_notification` item key `approval_request:<uuid>:notify` (a CHECK change).
   - `readApprovalsToNotify` (`packages/db`, `push-approval-write.ts`): requests waiting for Paul
     (no live decision, not withdrawn), never a `vault_reveal`, never the request Paul's own edit
     filed, with no claim, oldest first, at most `MAX_APPROVALS_READ` (205) a pass. A policy's
     approval is a decision at filing, so such a request never waits and is never pushed.
   - `claimApprovalNotification`: one claim per request, under the request's row lock (the lock
     deciding takes), only while it still waits.
   - `recordApprovalPushResult`: one push's outcome for every claim it covered, with one
     fixed-word feed line per push (on `approval:<id>`, or `candidate:<id>` for an overflow push).
   - The worker's pass (`apps/worker/src/activities/notify-approvals.ts`), after handoffs and before
     fresh jobs: the first `MAX_APPROVAL_PUSHES_PER_PASS` (5) claimed requests are pushed alone;
     the rest of the pass's requests are claimed too and share one `ApprovalsWaitingPush`
     (`{ v: 1, kind: "approvals_waiting", more }`, "N more requests are waiting in the Queue",
     opening `/approvals`, one tag so a newer one replaces the older). Each request is claimed
     once, ever, so none is pushed twice.
   - Stale claims, held-back pushes and pushes no browser took become `push.notify` dead letters,
     as in NS-193 (`approval:<id>`, or `candidate:<id>` for an overflow push).

The issue asks for one push per batch. This plan sends one per request instead, so a push can name exactly what it opens. An approval from a push then covers that one request, which Paul sees before approving. A second push for an item already decided opens a Queue that says it's no longer waiting, and the decide answers `already_decided`.

## Acceptance criteria (slice 1)
- [ ] A payload test shows an approval push holds only `v`, `kind`, `id` and `request`; any other key, a subject or a non-UUID id is refused, and it fits in 256 bytes.
- [ ] The service worker's words match `pushWords` for every queue kind. Anything else gets the generic line. A tap opens `/approvals?request=<id>` only for a valid UUID, else `/`.
- [ ] The Queue preselects and marks a waiting request named in `?request=`, says so when it isn't waiting, and ignores a bad id (web tests).
- [ ] lint, typecheck, test and build are green.

## Acceptance criteria (slice 2)
- [ ] The overflow payload holds only `v`, `kind` and a whole `more` from 1 to 200; the service
  worker's words and path match `pushWords` and `pushPath` for every count, and a bad one gets the
  generic line and `/` (domain tests).
- [ ] The reader lists waiting requests only: never one Paul decided (until he undoes it), withdrew
  or edited, one a policy approved, a reveal, one already claimed, or another candidate's; at most
  205 (db tests).
- [ ] A request is claimed once, never once decided or withdrawn, and a stale claim is reported
  (db tests).
- [ ] A pass pushes each waiting request once, five alone and one overflow push for the rest,
  claims nothing while `push` is off, stops when the breaker holds a push back, and reports an
  undelivered overflow push and a stale claim as dead letters (worker tests).

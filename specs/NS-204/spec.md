# NS-204: approve from a push notification on Paul's phone

Status: in progress (autonomous lane, ADR-0016)
Issue: #180 (parent #68) · Requirements: APR-003 · ADR-0002, ADR-0032; decision on #162
Rules that apply: `.claude/rules/web.md` (slice 2 adds `.claude/rules/db.md` and `.claude/rules/worker.md`)

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
2. **Next PR, needs the migration lane:** the sender.
   - A `push_notification` item key `approval_request:<uuid>:notify` (a CHECK change).
   - A reader of pending requests with no claim.
   - The worker's notifier pass, built like NS-193 slice 3. It pushes only pending requests that
     need Paul (never ones a policy auto-approved), at most 5 approval pushes a pass, then one fixed
     "N more waiting in the Queue" push, so a burst can't flood his phone (orchestrator).

The issue asks for one push per batch. This plan sends one per request instead, so a push can name exactly what it opens. An approval from a push then covers that one request, which Paul sees before approving. A second push for an item already decided opens a Queue that says it's no longer waiting, and the decide answers `already_decided`.

## Acceptance criteria (slice 1)
- [ ] A payload test shows an approval push holds only `v`, `kind`, `id` and `request`; any other key, a subject or a non-UUID id is refused, and it fits in 256 bytes.
- [ ] The service worker's words match `pushWords` for every queue kind. Anything else gets the generic line. A tap opens `/approvals?request=<id>` only for a valid UUID, else `/`.
- [ ] The Queue preselects and marks a waiting request named in `?request=`, says so when it isn't waiting, and ignores a bad id (web tests).
- [ ] lint, typecheck, test and build are green.

# NS-193: Notify Paul when an application needs his hands (web push)

Status: slice 3 in review (slices 1–2 merged: #442, #447; autonomous lane, ADR-0016)
Issue: #162 (parent #20). The decision comment on #162 (2026-11-28) also covers #172 and #180.
Requirements: APR-003, APPLY-006, ACC-007, RES-002, RES-006, RES-007, RES-008, OBS-001
Rules that apply: ADR-0002, ADR-0003, ADR-0007, ADR-0016, ADR-0018, ADR-0032 (web push, this
ticket), `.claude/rules/db.md`, `.claude/rules/web.md`, `.claude/rules/worker.md`

## Why
A challenge (CAPTCHA, sign-in, MFA, account wall) holds an application until Paul acts. Today he
only learns of it when he opens the app (NS-121's "Needs your hands" card and its feed line). It
should reach him: a push on his phone or desktop, from the PWA.

## Behavior
Built in three slices, each its own PR:

1. **Push sender (this PR).** ADR-0032 decides web push with self-generated VAPID keys and
   Northstar's own RFC 8291 / RFC 8292 code on `node:crypto` (no new dependency).
   `packages/gateways/src/push/`:
   - `encryptPayload` (RFC 8291 `aes128gcm`, one record) and `vapidAuthorization` (RFC 8292,
     ES256 JWT, `aud` the endpoint's origin, `exp` 12 h).
   - `endpointAllowed`: https only, the default port, a host under a known push service (FCM,
     Mozilla, Apple, Windows), no credentials; anything else is refused before any request (no
     SSRF from a stored subscription).
   - `createPushSender(...).send` builds the request and sends it through the global `fetch` with
     a 10 s limit, behind the `push` kill switch and the `push` breaker (only no answer, 429 or 5xx
     counts against it). 404 and 410 answer `gone` (the subscription is dead); other 4xx
     `rejected`.
   - The payload (`packages/domain`, `push-payload.ts`): `{ v: 1, kind: "handoff", id, ats,
     reason }` with the ATS and reason from fixed lists, checked by Zod (`strict`). Never a URL,
     company, job title or email text; `pushWords` gives the notification's fixed title and body
     ("A Greenhouse form stopped at a CAPTCHA. Open Northstar to finish it.", the feed's own words).
   - The VAPID settings get placeholders in the example env file's Apps part and a typed loader
     (`loadVapidConfig`).
2. **Subscriptions.** Append-only `push_subscription` and `push_subscription_removal`
   (migration; one per candidate and endpoint), the API's `GET /push/key`, `POST /push/subscribe`
   and `POST /push/unsubscribe` (session only), a service worker (`apps/web/public/sw.js`) that
   shows the fixed words and opens Today on tap, and "Turn on notifications" on Today.
3. **The handoff notifier.** For each open handoff with no notification, claim
   `apply_handoff:<id>:notify` once (append-only `push_notification`), send to each live
   subscription, record the result (`push.sent` event with a fixed-word feed line). A resolved
   handoff is never notified. A failed send becomes a `push.notify` dead letter. Runs on the
   worker's `pipeline` queue every minute, only when the VAPID settings are set.

## Acceptance criteria
- [ ] Slice 1: `encryptPayload` reproduces RFC 8291 Appendix A's message exactly; a VAPID JWT
      verifies with the public key and names the endpoint's origin; `endpointAllowed` refuses
      http, other hosts, ports, credentials and IP literals; the sender sends nothing while the
      switch is off or the breaker is open, and reports only push-service faults to the breaker.
- [ ] Slice 1: the payload test proves no URL, company or title can be in a push (Zod `strict`,
      fixed lists, a size cap).
- [ ] Slice 3: one notification per handoff even when the sender runs twice, and none after it is
      resolved (db and worker tests).
- [ ] AGENTS.md describes each slice.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Failure modes
- Push service slow or down: 10 s limit, the `push` breaker opens after 5 faults. A push is never
  retried (at most once): one no browser took is a `push.notify` dead letter (`not_delivered`) on
  `/health`'s Stuck work, and one the breaker held back is `push_paused` and stops the pass, so the
  other open handoffs keep their push for a later pass. A pass that fails all its attempts is a
  `notify_failed` letter.
- Turning push on for the first time pushes every handoff already open (at most 20 a pass).
- Subscription gone (404/410): removed (slice 3), not retried, not a breaker fault.
- No VAPID settings: no notifier runs; Today says notifications aren't set up.
- `push` switched off: nothing is sent; the notifier claims only while it is on.
- A crash between claim and send: at most once. A claim with no result is a dead letter
  (`outcome_unknown`), never a second push.

## Observability
- Span `push.send` (endpoint host only, status code, outcome; never the endpoint path, keys or
  payload). `push.sent` and the dead letters are the feed lines (slice 3).

## Out of scope
- Fresh-job alerts by push (#172) and approve from a push (#180): later tickets on this sender. A
  push alone never approves (#180 needs the session or a passkey assertion).
- iOS-specific install prompts; push without the PWA.

## Open questions
- The VAPID `sub` claim: Paul's `mailto:` or `https:` contact (`PUSH_VAPID_SUBJECT`). Push
  services may use it to reach him about abuse; it goes nowhere else.

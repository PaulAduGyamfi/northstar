# ADR-0032 — Web push with self-generated VAPID keys and Northstar's own sender

**Status:** Proposed · **Date:** 2026-11-28

## Context
A challenge (CAPTCHA, sign-in, MFA, account wall) holds an application until Paul acts
(APPLY-006, ACC-007, ADR-0003). NS-121 shows it on Today and in the feed, but only when he opens
the app. APR-003 wants approvals on the phone and a push that reaches him. #162 (NS-193) needs a
notification per new handoff; #172 needs the same channel for fresh-job alerts; #180 wants to
approve from a push.

Paul delegated the channel to the orchestrator on 2026-11-28 (the decision comment on #162): web
push from the PWA, VAPID keys Paul generates himself, no vendor account, fixed words and ids
only, one push per item by idempotency key, behind a `push` kill switch and breaker, failures as
dead letters. This record fixes the parts that comment left to the first agent: the library, the
threat model and where subscriptions live.

## Decision
1. **Web push (RFC 8030) from the PWA, VAPID (RFC 8292) with keys Paul generates.** A P-256 key
   pair made on his machine with the one-line `node` command in the example env file (the raw
   public point and the private scalar, base64url). The private key is only in `.env.app`
   (`PUSH_VAPID_PRIVATE_KEY`), with the public key (`PUSH_VAPID_PUBLIC_KEY`) and Paul's contact
   for the push services (`PUSH_VAPID_SUBJECT`, `mailto:` or `https:`). The example env file has
   placeholders; `loadVapidConfig` (`packages/gateways`, `src/push/vapid.ts`) is the typed loader
   and refuses a placeholder, a key of the wrong length or a public key that isn't the private
   key's own. No settings means no push: nothing else breaks.
2. **No library: Northstar's own sender on `node:crypto`.** `packages/gateways/src/push/`:
   - `encryptPayload` (`encrypt.ts`): RFC 8291 message encryption with RFC 8188 `aes128gcm`, one
     record, a fresh ECDH key and salt per message.
   - `vapidAuthorization` (`vapid.ts`): an ES256 JWT (`aud` the endpoint's origin, `exp` 12 h,
     `sub` the configured contact) in the `vapid t=…, k=…` header. It refuses an audience that
     isn't https.

   Conditions on this hand-written crypto (the orchestrator's, 2026-11-28), kept as tests:
   - a test reproduces RFC 8291 Appendix A exactly (its keys, salt, plaintext and message, byte
     for byte): the gate for any change to `encrypt.ts`;
   - a test verifies the VAPID signature with the public key, checks `aud`, `exp` (at most 24 h)
     and `sub`, and one refuses a non-https audience;
   - only allowlisted https endpoints are ever called (item 3);
   - the security reviewer reviews the crypto module itself in every PR that changes it.
   - `endpointAllowed` (`endpoint.ts`) and the sender (`send.ts`, `createPushSender`), below.

   The `web-push` package was the obvious choice. 3.6.7 (January 2024) brings five transitive
   dependencies, among them a proxy agent and an ASN.1 parser this sender doesn't need. 4.0.0
   (2026-11-06) passes the 14-day cooldown but is a new major release three weeks old. Both use
   Node's own HTTP client, so the sender's allowlist, time limit and breaker would have to wrap
   its request builder anyway. The code that remains is about 150 lines over `node:crypto`
   primitives (ECDH, HKDF, AES-128-GCM, ECDSA), checked against the RFC's test vector. So there
   is no new dependency and no supply-chain surface.
3. **The sender.** `createPushSender({ vapid, guard }).send(subscription, payload, span)`:
   - Refuses any endpoint `endpointAllowed` rejects, before anything else: https, the default
     port, no user info or fragment, and a host that is exactly `fcm.googleapis.com`,
     `updates.push.services.mozilla.com` or `web.push.apple.com`, or a subdomain of
     `notify.windows.com` (Windows' per-region hosts). Never an IP literal. A stored subscription
     can't point the worker at an internal host.
   - Checks the `push` kill switch, then the `push` breaker (ADR-0007), at the moment it sends.
     A check that throws holds the push back.
   - POSTs through the global `fetch` with a 10 s limit, `TTL: 86400` and `Urgency: high`.
   - Counts only no answer, 429 and 5xx against the breaker. Any 2xx is `sent`, 404/410 `gone`
     (drop the subscription), any other 4xx `rejected`.
   - Its span `push.send` holds the endpoint's host, the status and the outcome. Never the
     endpoint's path (it identifies the device), the keys, the JWT or the payload.
4. **Payload: fixed words and ids only.** `PushPayload` (`packages/domain`, `push-payload.ts`) is
   a strict Zod union. NS-193's member is `{ v: 1, kind: "handoff", id: <uuid>, ats: <ApplyAts>,
   reason: <challenge reason> }`, at most 256 bytes as JSON. `pushWords` gives the title and body
   from fixed sentences. The service worker shows only those words and opens Today on tap. A
   push never carries a URL, company, job title, email text or anything Paul typed. Push services
   see the ciphertext's size and timing only, and the words are fixed anyway.
   Amended in place for approval pushes (NS-204, #180; this ADR is still Proposed):
   - `{ v: 1, kind: "approval", id: <request uuid>, request: <kind code> }` names one request
     waiting in the Queue by its id and kind code only (`PUSH_REQUEST_KINDS`, never
     `vault_reveal`): never a subject, company, title or draft text.
   - A tap opens `/approvals?request=<id>`, built from the checked id, where the Queue marks
     that request. A push never approves: the notification has no action button and carries no
     token, and Paul approves in the Queue, signed in, through `POST /approvals/decide`, with the
     undo window as usual.
   - A pass pushes at most 5 requests alone. The rest share one
     `{ v: 1, kind: "approvals_waiting", more: <1-200> }` push ("N more requests are waiting in
     the Queue"), which opens `/approvals` and replaces the previous one (one tag). Each request
     is claimed once (`approval_request:<id>:notify`, item 6), so none is pushed twice.
   - Only a request filed in the last 24 hours (by the Gate's clock) is pushed, so turning push
     on never sends a backlog; older requests still wait in the Queue. A request a policy
     approved, or the one Paul's own edit filed, is never pushed.
5. **Subscriptions are append-only.** `push_subscription` (one per candidate and endpoint: the
   endpoint, `p256dh` and `auth` keys, created time) and `push_subscription_removal` (one per
   subscription: `user` or `gone`), written only through `push-write.ts` in `packages/db`, with
   `*_reject_change` triggers and `northstar_grant_app_role()`. A subscription is live while it
   has no removal. The API's subscribe routes are session only (ADR-0018) and check the endpoint
   with `endpointAllowed` before storing it.
6. **Delivery: at most once per item.** The notifier claims the item's key
   (`apply_handoff:<id>:notify` for NS-193) in append-only `push_notification` before it sends,
   then records the result. A second run finds the claim and sends nothing. A crash between
   claim and result leaves a claim with no result: a `push.notify` dead letter
   (`outcome_unknown`), never a second push. A send that fails its tries is a `push.notify` dead
   letter too (RES-007).
7. **A push never acts.** Opening a notification only opens the app. Approving from a push (#180)
   still needs Paul's signed-in session or a passkey assertion made for that one decision, as the
   vault reveal does (ADR-0024). The payload carries no token or grant.

## Threat model
- **A stolen subscription** (endpoint plus keys): lets someone push to Paul's browser. The
  service worker shows only the fixed words for known kinds and ignores anything else, so it
  can't be used to phish him with chosen text. The subscription is stored like other app data;
  Paul can remove it from Today.
- **A stolen VAPID private key**: lets someone push to subscriptions they also hold. It doesn't
  open any subscription by itself. The key lives only in `.env.app`; Paul rotates it by making a
  new pair, after which every browser subscribes again.
- **A malicious endpoint** (SSRF from the worker): refused by `endpointAllowed` before any request.
- **Push service privacy**: the services (Google, Mozilla, Apple, Microsoft) see when Paul gets a
  push and its size, never its words (RFC 8291 encryption). The words are fixed anyway.
- **Lock-screen exposure**: the words name only the ATS and the kind of challenge.
- **Floods**: one push per item key; the notifier's pass is bounded; the breaker and kill switch
  stop a misbehaving sender.

## Alternatives considered
- `web-push@3.6.7` or `4.0.0`: see item 2.
- A vendor (OneSignal, Firebase Cloud Messaging's SDK, ntfy, Pushover): a third-party account
  and a server holding notification content. Ruled out by the decision on #162.
- Email or SMS to Paul: needs a sender under his name (the Gate) or a vendor, and is slower to
  act on.
- No push, only the feed: what NS-121 has; it doesn't reach him.

## Consequences
- Northstar owns ~150 lines of crypto composition. The RFC test vector guards it; any change
  there needs the vector still passing.
- Paul generates and installs the VAPID keys once; push is off until he does.
- Every later push (#172, #180) adds a payload kind with fixed words and its own item key, and
  reuses the sender, the allowlist and the switch.
- Adding a push service host means changing `endpointAllowed` and this record.

# NS-123: Verification Catcher (email codes and magic links)

Status: autonomous lane (ADR-0016), not reviewed by Paul before work started
Requirements: VER-001, VER-002, VER-003, VER-004, VER-005, VER-006 (slice 1, see "Out of scope")
Rules that apply: ADR-0010 (item 4), ADR-0014, ADR-0003, ADR-0007, `.claude/rules/tests.md`,
`.claude/rules/gateways.md` (the catcher always gets the `security-reviewer`, ADR-0010)

## Why
Workday-style tenants and many ATS sign-ups send a one-time code or a magic link by email before
they let the candidate continue. Paul: *"handling sites that send confirmation codes to email to
verify it's me"* must be effortless (requirements 15). The catcher is the piece that, when a
gateway step expects such an email, picks the right message, pulls the code or link out with plain
code, and refuses anything that doesn't come from the expected sender, at the expected time, to the
expected host. Codes and links are secrets for a few minutes: they must never reach a log, a span,
an event or the feed.

## Behavior
This slice is the catcher's plain-code core in `packages/inbox/src/verify/`. No Gmail call, no
database, no model. A gateway (NS-124) will drive it once it exists.

1. **Open a window (VER-001).** `open` records what a gateway step expects: tenant, ATS,
   purpose (`sign_up`, `sign_in`, `submit`, `password_reset`), the sender domains allowed, the hosts
   a magic link may point to, and the time it opens. It closes 10 minutes later unless the caller
   asks for a shorter window (never longer than 30 minutes). Every allowlist entry must be a plain
   host name with a dot (`example.com`): no wildcard, no bare `com`, no IP address.
2. **Route a message to its window (VER-002).** `offer(message)` takes a message's headers and
   body. It goes to an open window only when:
   - Gmail authenticated the sender (DMARC pass or DKIM pass, `isAuthenticatedSender`) in the
     `Authentication-Results` header Gmail itself wrote (authserv-id `mx.google.com`), and the
     sender domain is one of the window's sender domains or under one. The header is read by its
     structure: a result counts only when its method comes first, and its domain only from its
     own `header.*` token, so a pass the sender wrote into its envelope address never counts;
   - the message arrived inside the window (`openedAt ≤ receivedAt ≤ expiresAt`);
   - the window hasn't been used yet, and this message id hasn't been used before.
   Exactly one window may match; two matching windows means the catcher can't tell which session
   the mail belongs to, so it uses neither and both stay open until a clear message or timeout.
   A message that matches no window is returned as `not_verification` and left to the inbox.
   A body over 256 KB is not scanned: the window becomes `needs_human` (`message_too_large`).
3. **Extract deterministically (VER-003).** From the message's text (and the `href`s in its HTML)
   the catcher finds:
   - a **code**: 4 to 8 characters, digits only or upper-case letters and digits with at least one
     digit, on a line that also says code, verification, one-time, passcode, PIN, OTP or security
     code (or on the line right after it);
   - a **link**: an `https` URL whose path, query or anchor text says verify, confirm, activate,
     validate, sign in, log in, magic link or reset.
   One distinct code is the result (a code wins over links, since mails often carry both). With
   no code, one distinct link is the result. More than one distinct code, or no code and more
   than one link, is a mismatch: the window becomes `needs_human` (`ambiguous_content`), never a
   guess. A message with neither (Workday's "welcome" mail often arrives before the verify mail)
   is `no_code_or_link`: the message is used up but the window stays open. (The LLM fallback on
   mismatch is a follow-up.)
4. **Link safety (VER-004).** A link is accepted only if it is `https`, has no user name or
   password, isn't an IP address, uses the default port, and its host is one of the window's link
   hosts or under one. `checkRedirectChain` applies the same rule to every hop a gateway saw while
   resolving redirects; one bad hop refuses the link. A link with a backslash, whitespace or a
   control character is refused too, since URL parsers disagree on those. What the catcher returns
   is the parsed URL it checked, never the raw text. A refused link becomes `needs_human`
   (`link_host_not_allowed`) and the link is never returned.
5. **Secrets stay secret (VER-005).** A code or link is returned inside a `VerificationSecret`.
   Its `reveal()` gives the value to the gateway; `toString`, `toJSON` and Node's `inspect` print
   `[redacted]`, so logging or serializing a result by mistake leaks nothing. The result carries a
   feed line with no code or link: `Verified email for Acme (Workday)`. The `verification.catch`
   span carries the window id, tenant, ATS, purpose, kind and outcome, never the code, link,
   subject, sender address or body.
6. **No email in time (VER-006).** `timeout(windowId)` asks for one "resend code" the first time
   (the window restarts from now for another full period, and only mail received after the
   resend counts, since many ATSs void the old code), and the second time closes the window
   as `needs_human` (`no_email`) with what was expected: tenant, ATS, purpose and sender domains.

## Acceptance criteria
- [ ] A code email from an authenticated allowlisted sender inside the window returns the code
      once; a second offer of the same message, or a second email, is refused (test).
- [ ] Mail from a forged or non-allowlisted sender, before the window or after it, never matches
      (tests).
- [ ] Two open windows that both match a message use neither (test).
- [ ] Codes are found in plain text and HTML; a message with two different codes is a mismatch
      that raises `needs_human`, and one with neither code nor link leaves the window open (tests).
- [ ] A pass the sender wrote into its own envelope address, or a header Gmail didn't write, never
      authenticates a sender (tests).
- [ ] Extraction stays linear on hostile HTML, and a body over 256 KB is never scanned (test).
- [ ] VER-004: a magic link to a non-allowlisted host, an `http` link, a link with credentials or
      an IP host, or a redirect chain with one bad hop, is never returned and raises `needs_human`
      (tests).
- [ ] VER-005: `JSON.stringify`, `String()` and `util.inspect` of every result contain no code or
      link, and the recorded span attributes don't either (tests).
- [ ] VER-006: the first timeout asks for a resend, the second raises `needs_human` naming what
      was expected (tests).
- [ ] `pnpm --filter @northstar/inbox lint`, `typecheck` and `test` pass.

## Failure modes
- **Gmail slow or down:** no message reaches `offer`; the window times out, asks for one resend,
  then becomes `needs_human` (VER-006). Nothing is retried forever.
- **Garbage or hostile email** (job pages and emails are untrusted, NFR-SEC-004): it can only
  produce a mismatch or a refused link. It can't open a window, pick a window, widen an allowlist
  or make the catcher open a URL: the catcher never fetches anything.
- **Clock:** every time comes from the caller's `now()`, so tests use fixed clocks and a gateway
  uses one clock for a window's whole life.

## Observability
One `verification.catch` span per `offer` that matched a window (one per window when a message
matched two), and one per `resend` or `no_email` timeout decision, with
`verification.window_id`, `verification.tenant`, `verification.ats`, `verification.purpose`,
`verification.kind` (`code`/`link`/`none`) and `verification.outcome`. Domain events and the feed
entry are written by the gateway that owns the session (NS-124), from the `feedLine` and outcome
this returns; there is no gateway yet.

## Out of scope
- **Gmail push** (VER-002's "Gmail push") and **labelling/archiving** used messages (VER-005's
  `Northstar/Verification` label). Both need more than ADR-0014 allows (a stored token and a watch
  for push, `gmail.modify` for labels). Paul's decision: `needs:paul` follow-up.
- **LLM extraction fallback** (VER-003, on mismatch): a new route with an eval set; agent-filed
  follow-up. Until then a mismatch is `needs_human`.
- **Persisting windows** across processes (a database table). The gateway session that opens a
  window doesn't exist yet, so the window store is in memory behind a small interface.
- **Keeping verification mail out of the funnel backfill** (INB-012): follow-up.
- Tagged applicant addresses (VER-007), the tenant registry and Workday flow (NS-124).

## Open questions
- The code keywords and link words are inferred from common ATS mails, not from Paul's inbox.
  A labelled private set of real verification mails would show what they miss.

# NS-148: Poll Gmail while a verification window is open

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: VER-002 (route the verification mail to the waiting session within seconds).
GitHub issue #89. Decision on #89 (Paul's delegation, 2026-11-26):
- poll during an open window instead of push;
- no `gmail.modify`, so the label and archive part of VER-005 is dropped for now.

Rules that apply: ADR-0014 (`gmail.readonly`, token in memory for one run), ADR-0010 item 4,
`.claude/rules/gateways.md`, `tests.md`.

## Why
The Verification Catcher (NS-123) decides on messages it is given, but nothing fetches them. A
gateway step waiting for a code needs its email found within seconds. Push would need a Pub/Sub
topic and a stored token, which ADR-0014 forbids. Polling only while a window is open needs
neither.

## Behavior
`pollWindow(deps, window)` (`packages/inbox/src/verify/poll.ts`), plain code with injected I/O.

1. **Each tick:**
   - List message ids with one Gmail query: the window's sender domains, received after the
     window opened (`from:(a OR b) after:<seconds>`, one minute of slack for clock skew).
   - Fetch and offer only ids not seen before, at most 10 a tick.
   - Offer each through `catcher.offer`, or `offerAssisted` when a `pick` is given.
2. **It stops on:**
   - `verified` or `needs_human`, returning that result;
   - the window's expiry, returning `timed_out`, after which the caller asks
     `catcher.timeout(windowId)` (wait, resend once, then `needs_human`; VER-006).
3. **What it ignores:** `not_verification`, `ambiguous_window` and `no_code_or_link` leave the
   window waiting.
4. **Interval:** 5 s by default, the sleep injected. It never sleeps past the window's expiry.
5. **A Gmail error never ends the wait early.** Only the two Gmail calls are guarded. A bug in
   the catcher still throws, and a message whose fetch failed isn't marked seen.
   - The error can be a failed call, or `HeldBack` from the `gmail` breaker (NS-174).
   - The tick is skipped and the next one retries.
   - A timeout result carries the last error's name, never its message.
6. **Spans:** one `verification.poll` span per window, with the window id, ticks, messages
   offered and the outcome. No query, sender, subject or code goes on it.
7. **The secret stays a `VerificationSecret`:** the result passes the catcher's result through
   unchanged.

## Acceptance criteria
- [ ] A matching mail arriving on the third tick is found and returned as `verified`, after
      exactly three list calls (inbox tests, fake Gmail and catcher clock).
- [ ] The query names only the window's sender domains and the window's start.
- [ ] A message seen on one tick is never fetched again.
- [ ] No mail before expiry returns `timed_out`, and the loop doesn't sleep past `expiresAt`.
- [ ] A Gmail error on one tick doesn't stop the loop, and the timeout names it.
- [ ] `needs_human` from the catcher ends the loop with that result.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Known gaps (recorded as decisions)
- **Magic links that exist only as HTML buttons aren't seen.** `getFull` returns the text part,
  or text made from the HTML without its links. Such a mail ends as `no_code_or_link`, then the
  window resends (fail safe). Passing the raw HTML part needs a `gmail.ts` change, which is
  outside this plan.
- **A result can come late.** One Gmail call can take minutes (the client's retries and
  Retry-After), so `timed_out` can come after `expiresAt`. Tying a deadline or an AbortSignal
  to the window is for the caller, the gateway session (NS-151).
- **Spam and trash aren't searched.** `messages.list` leaves them out by default.
- **A resend means a new call.** The caller calls `pollWindow` again with the renewed window.
  Ids already seen are fetched once more, and the catcher refuses them.

## Out of scope
- Who calls it: the gateway session (NS-151) wires the catcher, the poller and the timeout.
- Push (Pub/Sub) and `gmail.modify` labels, per the decision on #89.

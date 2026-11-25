# NS-150: Keep verification mail out of the funnel backfill

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: VER-005 (codes and links are never stored or shown). GitHub issue #91, parent #22
(NS-123). Related: INB-012 (verification mail never enters the inbox pipeline), which the
live pipeline will need too; this ticket covers the backfill only.
Rules that apply: ADR-0010, ADR-0014 (read-only Gmail), AGENTS.md (code decides; untrusted text
is data; public repo, synthetic fixtures only), `.claude/rules/tests.md`.

## Why
The funnel backfill keeps mail from authenticated ATS senders. A Workday or Greenhouse "verify
your email" or "your code is" message passes that pre-filter, so its body (with the code or link)
can be sent to the `mail-classify` model and the message stored in `funnel_message`. VER-005 says
codes and links are never stored and never shown, and a model call record or fixture is a store.

## Behavior
1. **`isVerificationMail(headers)`** (`packages/inbox`, `src/verify/detect.ts`, plain code,
   headers only). True when the sender domain is at a known ATS (`ATS_DOMAINS`, verified by Gmail
   or not) and the subject holds a verification phrase (`VERIFICATION_PHRASES`: "verify your
   email", "verification code", "security code", "one-time code", "passcode", "login code",
   "sign-in link", "confirm your account", "reset your password" and a few spellings of these).
   Case-insensitive; any run of whitespace, a non-breaking space included, reads as one space.
   - An unverified sender counts too: skipping a forged message only keeps it out of the funnel,
     which costs nothing, while letting it through could send a code to the model.
2. **`hasVerificationCode(senderDomain, body)`**, the second check, for a caller that already
   holds a body: an ATS sender whose body gives a code by `extractVerification`'s rules (VER-003
   patterns, INB-012). Codes only, since ATS job mail often carries portal links.
3. **The backfill skips them** (`packages/funnel`, `runBackfill`):
   - By subject, before anything else happens to the message: it is not classified by rules or
     the model, not fetched in full, not stored, and it doesn't make its thread a job thread.
     This applies to messages from the search and to messages found through a job thread.
   - By body, for a message whose subject the list missed: the backfill already fetches the body
     for the model, so it checks `hasVerificationCode` first and drops the message unsent and
     unstored. The body is only held in memory, as before.
4. **Counted, not described.** `BackfillCounts.verificationSkipped` counts both. The CLI prints
   "Verification mail skipped: N." on its own line when N > 0, and the count goes into the
   `funnel.backfilled` event payload like the other counts. No subject, sender, code or link
   appears anywhere.
5. Because nothing is stored, a rerun lists them again and skips them again (counted again).

## Acceptance criteria
- [ ] `isVerificationMail` is true for each phrase from an ATS sender, false for a confirmation
      ("Thank you for applying") from the same sender, and false for a verification subject from
      a non-ATS sender or a look-alike domain (`notlever.co`) (inbox tests).
- [ ] A synthetic verification mail from an ATS sender is neither classified, fetched, sent to
      the model nor stored, and is counted; a confirmation in the same run still is classified
      and stored (funnel tests).
- [ ] A verification mail alone in a thread doesn't pull the thread's other messages in.
- [ ] An ATS mail with a neutral subject whose body gives a code never reaches the model and isn't
      stored (funnel tests); an ATS body with only a portal link isn't treated as verification
      (inbox tests).
- [ ] The CLI prints the skip count (funnel cli test).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **A verification mail with an unusual subject** ("Your Acme sign-in") is caught by the body
  check if it gives a code. A magic link with no code and an unusual subject still reaches the
  model, as it does today; the phrase list is the place to extend.
- **A real job mail with a verification phrase** (unlikely: "confirm your account to see your
  interview slot") is skipped. Paul can add it with `funnel import`.
- No new I/O, so no new dependency can be slow or down.

## Observability
- `funnel.backfilled` payload gains `verificationSkipped` (a number). No new event type.

## Out of scope
- Verification mail from a company's own domain (not an ATS). The issue scopes it to ATS
  senders; the live pipeline (INB-012, NS-158) routes by open verification windows instead.
- Removing verification messages an earlier backfill run already stored. Stored rows hold no
  body (kind, company, role, requisition and stage only), and `funnel_message` is Paul's data,
  so any cleanup is his call.
- Labelling or archiving (`gmail.modify`, NS-148).

## Open questions
- Whether the phrase list should grow from Paul's real mail. Agents can't read it; Paul can add
  phrases in a later ticket.

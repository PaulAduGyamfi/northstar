# NS-160: Review leftovers: sender and header hardening, apply feed lines, stale comment

Status: accepted (autonomous lane, ADR-0016)
Requirements: VER-002, OBS-002, RES-008
Rules that apply: ADR-0007, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
Small items the NS-123 and NS-125 reviews left open (PRs #93, #105).

## Behavior
1. `isAuthenticatedSender` (`packages/inbox/src/prefilter.ts`) refuses a `senderDomain` that
   isn't shaped like a host name: letters, digits and hyphens in dot-separated labels, at least
   two labels, no label starting or ending with a hyphen, at most 253 characters.
2. `headersOf` (`packages/inbox/src/gmail.ts`) reads Gmail's own `Authentication-Results` header
   (authserv-id `mx.google.com`) wherever it sits among the headers. A message with no Google
   header reads the first one, as before (the existing test's single non-Google header); Gmail
   stamps its own on every message it receives, so a forged header below it is never read.
3. `packages/db/src/kill-switch-write.ts`: the comment says Paul's reason is shown in the feed;
   by design it is shown on the health view (`systemHealth`) and never in the feed. Comment fixed.
4. `packages/domain/src/feed.ts`: templates for `apply_submission.claimed`, `.submitted` and
   `.needs_human` from shape-checked payload fields only (the ATS name and the reason code from
   `NEEDS_HUMAN_REASONS`), added to the `FEED_TYPES` test.

## Acceptance criteria
- [ ] A sender domain with a space, slash, `@`, an empty label or a single label is not
      authenticated, even when the results header names it.
- [ ] With Gmail's header after another one, the Google one is read.
- [ ] Each apply event has a plain feed line; an unknown ATS or reason falls back to plain words.

## Failure modes
None new: all plain code on data already read.

## Out of scope
Anything else from those reviews.

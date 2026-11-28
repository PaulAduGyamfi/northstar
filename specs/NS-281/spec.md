# NS-281: Give the drafts their callers: reply drafts to Gmail drafts, follow-up nudges, answer drafts

Status: draft
Requirements: RPL-002, RPL-004 (parent #117 cites RPL-001…004); ANS-004 and INB-004 are named on
#459 but not on its parent (see Open questions)
Rules that apply: ADR-0002, ADR-0014, ADR-0025, ADR-0016, `.claude/rules/db.md`, Paul's decision on
#400 (consent each run, no stored token, no schedule)

## Why
The drafting pieces are built and checked, but nothing calls them. An approved reply never reaches
Gmail (`writeReplyDraft` has no caller), follow-ups are never filed (`nudgesDue` / `nudgePackage`
have no caller), and the package step can't use a drafted answer.

## Behavior
Slice 1 (this PR): **approved reply → Gmail draft.**
- `funnel drafts` is a one-shot command Paul runs. It lists the `email_reply` requests whose newest
  live decision is an approval past its undo window by the Gate's clock, not undone, not withdrawn,
  with a stored `reply_draft` and no `reply_draft_record` for that decision
  (`readApprovedReplies`, `packages/db`, read-only, ids only, at most 50).
- Only when there is something to write does it ask Google consent (`authorizeCompose`:
  `gmail.compose` only, PKCE, the token in memory for this run, no refresh token).
- Each one goes through `writeReplyDraft` with the stored ledger (`dbMailLedger`), the Gate's
  `verifyApproval`, and the `gmail_drafts` kill switch and `gmail` breaker. It creates a draft and
  never sends.
- A write that throws, or a refusal no later run can clear (`NotFound`, `ContentMismatch`, a Gate
  refusal other than the undo window, claims exhausted, a different draft recorded), becomes a
  `mail.draft_write` dead letter, passed over until Paul retries it. `InProgress`, `HeldBack` and
  `UndoWindowOpen` wait for a later run. Gmail not answering (no answer, 429, 5xx) stops the run with
  no letter. A grant without compose stops it with `scope_missing`.
- It prints counts only.

Slice 2: **follow-up nudges.** `funnel inbox` files nudges for applications `nudgesDue` picks,
through `nudgePackage` and `fileReplyDraft`, only while a setting turns it on (off by default).

Slice 3: **answer drafts** (ANS-004), pending the scope question below.

## Acceptance criteria
- [ ] `readApprovedReplies` lists only approved, effective, not undone, not withdrawn, unwritten
      `email_reply` requests with a stored draft (PGlite tests).
- [ ] `runDrafts` asks no consent when nothing is approved; writes each; records letters for lasting
      refusals and throws; skips the rest; stops on Gmail down and on scope missing (fakes).
- [ ] Run twice: a second run writes nothing new (the reader drops recorded decisions; the ledger
      answers `already_created`).
- [ ] `funnel drafts` is wired in `bin.ts` and named in AGENTS.md and the README.

## Failure modes
- Consent cancelled or timed out: the run stops, prints the error's class name, nothing written.
- Gmail down / rate limited: stop, no letter; the claim's lease lets a later run continue.
- Kill switch off or breaker open: `HeldBack`, skipped this run.
- Database refuses: the command prints the error's class name and exits 1.

## Observability
`writeReplyDraft`'s `gmail.write_reply_draft` span and `reply.draft_created` event (existing);
`dead_letter.recorded` for each letter. No new event types.

## Out of scope
Sending mail. A stored refresh token or a scheduled run (#400). A worker caller.

## Plan (slice 1)
1. `readApprovedReplies` (`packages/db`, `reply-approved-read.ts`), by `readApprovedPrepPlans`' rule.
2. `mail.draft_write` in `DEAD_LETTER_KINDS` (only a shape CHECK in the database: no migration) and
   its words in `apps/web/src/dead-letters.ts`.
3. `runDrafts` and `draftsCommand` (`packages/funnel`, `drafts.ts`), plain code over ports.
4. `funnel drafts` in `cli.ts`, wired in `bin.ts` (`authorizeCompose`, `writeReplyDraft`,
   `dbMailLedger`, `verifyApproval`, the stored guard), loaded only when a reply is waiting.
5. AGENTS.md, README and `.claude/rules/db.md`.

## Decisions made without Paul
- **Scope beyond the parent's requirements.** #459 cites ANS-004 and INB-004, which its parent #117
  doesn't (ADR-0016 item 2). The orchestrator relayed Paul's order for the follow-up issues ("Ok make
  sure there are issues for the what if do next and do them in order next", 2026-11-28, in the
  orchestrator's session), so #459 as written, answer drafts included, is in scope. Slices 1 and 2
  stay within RPL-002/RPL-004.

# NS-238 slice 2: a reply draft by recruiter grade

Status: done, in review (autonomous lane, ADR-0016)
Issue: #266, item 2
Requirements: REC-002 (A/B interested, C more info, D/F decline or archive), RPL-002 (Gate filing)
Rules that apply: ADR-0002 (nothing sent; Paul approves), ADR-0004 (no claim without a cite),
ADR-0016, `.claude/rules/tests.md`

## Why
A recruiter email gets an A–F grade (slice 1), but nothing turns the grade into a reply Paul can
approve. #263 slice 1 made the Gate filing (`fileReplyDraft`), and slice 3 built nudges as fixed
text that states nothing to cite. A reply by grade fits the same shape.

## Behavior
- `recruiterReplyKind(grade)` (`packages/profile`, `reply/recruiter.ts`, plain code): A or B →
  `interested`, C → `more_info`, D → `decline`, F → `archive` (a dealbreaker, an upfront fee or a
  request for sensitive data: no reply goes to that sender; the suggestion is to archive).
- `RECRUITER_REPLY_SENTENCES` holds one fixed sentence per replying kind. None states a fact,
  figure, time, link, name or commitment word (`isCommitmentWord`: so no "decline", "pay",
  "start", "available"), so there's nothing to cite and nothing to invent.
- `recruiterReplyPackage({ gmailMessageId, threadId, inbound, grade })` builds the reply package
  exactly as `nudgePackage` does: the envelope from the message's own headers (`replyEnvelope`),
  the greeting with the From header's checked first name only (none with a Reply-To), the body
  "<greeting> Thank you for reaching out. <sentence>", no cites, no follow-ups. It refuses a
  no-reply recipient (`NoReplyAddress`, shared with nudges) and answers `ArchiveSuggested` for F.
  `fileReplyDraft` files it as an `email_reply` like any reply (tested on PGlite).
- No caller yet: grades are recorded only once classifications are stored (#224/#293).

## Acceptance criteria
- [x] Each grade maps to its kind, and F never yields a package (tests).
- [x] The package's envelope, greeting and body for each replying kind (tests).
- [x] No sentence holds a commitment word, digit, link or address (test).
- [x] A no-reply recipient is refused (test); a package files with the Gate (PGlite test).
- [ ] `packages/profile` lint, typecheck, test, build green (CI `checks`: this container's Node 22
      can't install the workspace, which pins Node 24).

## Out of scope
- Model-drafted replies by grade (the `reply-draft` route stays off until Paul's fixtures).
- Learning from Paul's actions and the agreement measure (items 3–4: they need his labels).

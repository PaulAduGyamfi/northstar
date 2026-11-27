# NS-261 slice 1: store each linked message's classification

Status: in progress (autonomous lane, ADR-0016)
Issue: #376 (parent #294)
Requirements: INB-003, INB-004, INB-010, INB-012
Rules that apply: ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`

## Why
`classifyLinkedMail` (`packages/inbox/src/triage.ts`) decides a linked message's kind, but
nothing stores it. The credit report's inbox stages (#294), follow-up nudges
(`readNudgeCandidates`), recruiter grading in the mail loop (#266) and the Inbox tab's
"Not classified yet" all wait on it.

## Behavior
- **Storage** (`packages/db`, migration 0098, `mail-classification-schema.ts`): append-only
  `mail_classification`, one row per candidate and Gmail message:
  - `outcome` is `classified` or `review`;
  - for `classified`: `kind` (INB-003's `MAIL_KINDS`), `stage_signal` (`STAGE_SIGNALS`) and
    `decided_by` (`rules` or `model`);
  - for `review`: `review_reason` (`refused`, `truncated`, `invalid_output`, `ambiguous`,
    `provenance`), always decided by `model`;
  - `prompt_version` when the model decided, null for rules.

  CHECKs keep those shapes. It never stores a company, role, requisition, subject, body or address:
  the classification's extracted names stay out. Like `recruiter_grade`, there's no foreign key to
  `mail_link` (TRUNCATE would hit the foreign-key error before the append-only trigger); the write
  checks the message's `mail_link` in its transaction.
- **Write** (`mail-classification-write.ts`): `recordMailClassification(db, { candidateId,
  gmailMessageId, result })`.
  - It checks the input (Zod), then refuses a message the mail loop never recorded
    (`UnknownMessage`).
  - It stores the row once; a repeat stores nothing, and the first decision stands.
  - It writes `mail.classified` (message id, kind, stage signal, decided by) or
    `mail.needs_review` (message id, reason), each with a fixed-word `reason` as its feed line, in
    the same transaction.
- **Reads:** `readInboxThreads` gives each linked thread its newest classified message's kind (null
  when none). `readNudgeCandidates` gives the newest message's stored kind (null when it isn't
  classified, or went to review), so nudges can come due.
- `readMailClassifications(db, candidateId, gmailMessageIds)` gives stored rows by message, for
  #266's grader and the credit report.
- No caller classifies new mail yet: the worker (#230) calls `classifyLinkedMail` then this.

## Acceptance criteria
- [x] Stored once per message, the repeat stores nothing, an unknown message is refused, a bad shape
      is refused (PGlite).
- [x] The table refuses UPDATE, DELETE, TRUNCATE and bad shapes written directly.
- [x] The events and their feed lines carry codes only.
- [x] The Inbox read shows the newest classified kind per thread; the nudge read shows the stored
      kind, and a nudge comes due from it (PGlite).
- [x] lint, typecheck, test, build green (CI `checks`: this container's Node 22 can't install the
      workspace).

## Out of scope
- The caller (#230), the credit report's stages (#294 item 2) and grading in the loop (#266).

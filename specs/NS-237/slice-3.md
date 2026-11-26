# NS-237 (slice 3): Decide which applications are due a follow-up nudge, and package the nudge

Status: done
Requirements: RPL-004, RPL-002 · ADR-0002, ADR-0004
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`.
Parent: #117, issue #263 (item 3).

## Why
RPL-004: when an application or interview has had no response for N days (configurable per
stage), draft a polite follow-up for approval, through the same checks and the same Gate filing as
a reply. Slices 1 and 2 file and show reply drafts. This slice decides when a nudge is due and
builds the nudge as a reply package. Code decides, and the nudge body is fixed text that states no
fact, so there's nothing for a model to invent.

## Behavior
- **`packages/domain`, `follow-up.ts`:**
  - Stages: `applied` (`submitted`, `confirmed`) and `interview` (`in_process`).
  - `DEFAULT_NUDGE_DAYS` is `{ applied: 7, interview: 5 }`. `parseNudgeDays` accepts whole days from
    1 to 60 per stage and names a bad field.
  - `nudgesDue(candidates, days, now)` works out which applications are due. An application is due
    when all of these hold:
    - its status is in a stage;
    - it has a linked message to reply on;
    - no reply draft is filed for that message;
    - the newest of its last status move and its newest linked mail is at least that stage's days
      ago.

    Each due item gives the application, stage, message, thread and whole days silent, oldest first.
- **`packages/db`, `nudge-read.ts`:** `readNudgeCandidates(db, candidateId)` reads, for each of the
  candidate's applications in a nudge stage:
  - its status and the time of its last status move;
  - its newest linked message (Gmail id, thread, received time);
  - whether a `reply_draft` exists for that message.

  It reads ids and times only.
- **`packages/profile`, `reply/nudge.ts`:** `nudgePackage({ gmailMessageId, threadId, inbound,
  stage })` builds the reply package for a nudge.
  - The envelope comes from `replyEnvelope` and the flag from `replyToOtherDomain`.
  - The body is a fixed text per stage: a greeting with `greetingName`'s first name where there is
    one, one fixed follow-up sentence and a sign-off.
  - There are no cites and no follow-ups. `fileReplyDraft` files it as an `email_reply` like any
    reply.

## Acceptance criteria
- [x] `nudgesDue` covers each condition: due, not yet due, already filed, no thread, not in a stage,
      newer mail resets the clock, per-stage days, oldest first.
- [x] `parseNudgeDays` refuses days outside 1–60, or that aren't whole numbers, naming the field.
- [x] `readNudgeCandidates` reads the newest linked message, the last move, the filed flag and only
      the candidate's own applications in a stage (PGlite).
- [x] `nudgePackage` builds a package with a fixed body that files with `fileReplyDraft` (PGlite),
      and refuses a bad sender header.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- The nudge body is fixed text, not a model draft. It states no fact, figure, time or commitment,
  so it needs no evidence and the model's framing allowlist is left unchanged.
- The days per stage are an argument with defaults, not yet a setting. The caller (#224) loads them
  through the typed config.
- An application with no linked thread isn't nudged: there is nothing to reply on, and new mail
  goes through the writer later.

## Out of scope
- The caller in the mail loop (#224), the Gmail writer (ADR-0025, item 2), outreach follow-ups
  (OUT-*), thank-you notes (RPL-005).

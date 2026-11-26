# NS-238 (slice 1): Store a recruiter message's grade and show it in the feed and the Inbox

Status: done
Requirements: REC-001, REC-002 · ADR-0002, ADR-0004
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/web.md`, `.claude/rules/tests.md`.
Parent: #118, issue #266 (item 1).

## Why
NS-167 grades a recruiter message A–F in plain code (`gradeRecruiterMessage`) with reason codes,
but nothing stores the grade or shows it. REC-002 says to show the grade with its reasons. This
slice stores one grade per recorded message, says so in the feed, and shows it on the Inbox tab.
The caller that grades each `recruiter_inbound` message comes once classifications are stored.

## Behavior
- **`packages/db`, `recruiter-grade-schema.ts` and `recruiter-grade-write.ts`:**
  - `recruiter_grade` is append-only and holds one row per candidate and Gmail message. A foreign
    message must have a `mail_link`, which `recordRecruiterGrade` checks in the same transaction. It holds:
    - the grade (`A`–`F`);
    - the points;
    - reason codes, 1–12 from the fixed list `RECRUITER_GRADE_REASONS` (`packages/domain`), checked
      by Zod, a CHECK and the API;
    - the confidence (`normal` | `low`).
  - `recordRecruiterGrade(db, { candidateId, gmailMessageId, grade })` writes the row and a
    `recruiter.graded` event in one transaction. The event carries the Gmail message id, grade, confidence
    and reasons (the grade id is its aggregate), never email text. The same message recorded again stores nothing.
  - `readRecruiterGrades(db, candidateId, gmailMessageIds)` is a read.
- **Feed:** `recruiter.graded` reads "Graded a recruiter email: B". Low confidence adds "(little
  to go on)".
- **Inbox:** each thread, linked or waiting to be linked, carries its newest graded message's grade,
  reasons and confidence, or null. `GET /inbox` passes them on. The web app shows "Recruiter grade
  B" and the reasons in words (`gradeWords`), with "little to go on" for low confidence.

## Acceptance criteria
- [x] The table refuses a bad grade, bad reasons, a bad Gmail id, and any update or delete; the
      write path refuses a message with no `mail_link` (PGlite).
- [x] `recordRecruiterGrade` stores the grade and event once; a repeat stores nothing.
- [x] The feed line, with and without low confidence.
- [x] `readInboxThreads` gives the newest grade per thread, for linked and queued threads, and only
      the candidate's own.
- [x] `GET /inbox` and the web words.
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- A schema change: one new append-only table and its migration.
- One grade per message: a regrade (REC-003) comes with Paul's actions, in a later slice.
- No foreign key to `mail_link`. It would make `TRUNCATE mail_link` fail with Postgres's
  foreign-key error before mail_link's own append-only refusal, and an existing test pins that
  refusal. The write path checks the `mail_link` in its transaction instead, and a CHECK keeps the
  Gmail id's shape.

## Out of scope
- The caller in the mail loop (classifications aren't stored yet).
- Drafts by grade (item 2, after #263's writer).
- Learning (item 3) and the agreement measure (item 4), which need Paul's actions and labels.

# NS-238 item 3, slice 1: Paul regrades a recruiter email

Status: in progress (autonomous lane, ADR-0016)
Issue: #266 item 3 (parent #118)
Requirements: REC-003 (and REC-001's "Paul's own A–F labels")
Rules that apply: ADR-0002, ADR-0012 (append-only), ADR-0016, `.claude/rules/db.md`,
`.claude/rules/web.md`, `.claude/rules/tests.md`

## Why
REC-003 says grading learns from Paul's actions on graded emails. The first action to learn from is
his own grade: when he thinks a graded recruiter email deserves another letter, he says so. Slice 2
turns those regrades into bounded weight adjustments; this slice only records them and shows them.

## Behavior
- **Storage** (`packages/db`, migration 0102, `recruiter-regrade-schema.ts`): append-only
  `recruiter_regrade`, one row per change of Paul's letter for a graded message (`A`–`F`). The
  newest row per message is his current grade. Letters and ids only: never email text.
- **Write** (`recruiter-regrade-write.ts`): `regradeRecruiterMessage(db, { candidateId,
  gmailMessageId, grade })`.
  - It refuses a message with no stored `recruiter_grade` (`NotGraded`), and a bad letter or id.
  - A letter equal to his current one stores nothing, so a repeat stores nothing.
  - Each stored regrade writes `recruiter.regraded` by `user` (message id, the system's letter and
    his letter), with a fixed-word feed line: "You regraded a recruiter email: B to D".
  - It never drafts, files, sends or archives anything.
- **Reads:** `readInboxThreads` gives a graded thread Paul's newest letter beside the system's
  (`recruiterGrade.paulGrade`, absent when he hasn't regraded).
- **API** (session only): `POST /inbox/regrade` `{ gmailThreadId, grade }` regrades the thread's
  newest graded message: `{ recorded }`, `404 not_graded`, `400`, `503 unavailable`. `GET /inbox`
  passes `paulGrade` on.
- **Web** (`/inbox`): a graded thread shows "You: D" when he regraded it, and a letter picker with
  Regrade.

## Acceptance criteria
- [ ] A regrade stores once; a repeat of the same letter stores nothing; a later different letter
      is a new row and becomes current; an ungraded message is refused (PGlite).
- [ ] One event per stored regrade, by Paul, codes only; the table refuses UPDATE, DELETE,
      TRUNCATE and bad rows.
- [ ] The Inbox read shows Paul's newest letter; the API and web words (tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Weight adjustments from regrades (slice 2), replies and archives as signals, the agreement
  measure (item 4).

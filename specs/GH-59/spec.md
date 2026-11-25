# GH-59: Answer bank storage, reuse and save on approve (slice 1)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: ANS-003 (reuse with usage count), ANS-005 (approval; inline edits saved),
ANS-006 (save on approve, linked to the application). ANS-001's answering of factual questions
from profile settings is split into a follow-up issue (see "Out of scope"). GitHub issue #59,
parent #17 (NS-118).
Rules that apply: AGENTS.md (approval is architecture; code decides, the model drafts; safe to
repeat; if it isn't in the feed, it didn't happen), ADR-0002 and ADR-0017 (the Approval Gate),
ADR-0004 (answers cite stories and atoms), ADR-0012 (events in the same transaction),
`.claude/rules/db.md`, `.claude/rules/tests.md`.

## Why
NS-118 taught Northstar *which* canonical question a form asks. The next step is remembering
Paul's approved answers to those questions, so the next form that asks "Why are you interested in
this position?" starts from words he already approved instead of a fresh draft, and says how
often that answer has been used.

## Behavior
1. **Tables** (`packages/db`, `answer-schema.ts`), every row with a `candidate_id`:
   - `bank_answer`: one approved answer to one narrative canonical question (`canonical_id`,
     `kind` `reusable_narrative` or `company_specific`, a `version` per canonical question, a
     required `short_text` and an optional longer `long_text`; `{company}` is the only slot), and
     the Approval Gate decision that let it in (`approval_decision_id`, unique).
   - `bank_answer_citation`: the approved stories or the atoms an answer cites (exactly one of the
     two per row).
   - `bank_answer_use`: each application an answer was used in (`approved` the first time,
     `reused` after), with `edited` when Paul changed the draft before approving. One row per
     answer and application.
   All three are append-only (a trigger refuses UPDATE, DELETE and TRUNCATE). A changed answer is a
   new version; the newest version is the bank's answer.
2. **Save on approve** (`saveApprovedAnswer`): the caller picks the answer id, asks the Gate for an
   approval of kind `answer` with subject `answer:<id>` and the SHA-256 of the answer
   (`answerContentSha256`: canonical id, kind, short and long text, application id). Once Paul approved it (with his
   inline edits: the edited text is what is hashed, approved and stored), the save verifies the
   decision with `verifyApproval`, refuses one decided by a policy (answers are never
   auto-approvable), checks every cited story is approved, and writes the answer, its citations,
   its first use and one `answer.approved` event in one transaction. Saving the same id twice
   writes nothing the second time.
3. **Reuse** (`readBankAnswer`, `recordAnswerReuse`, and in `packages/profile` `adaptAnswer` and
   `reuseNote`): the newest approved answer for a canonical question with its use count over all
   versions; `adaptAnswer` fills `{company}` and picks the long text if it fits the form's length
   limit, else the short one. It never cuts text: if neither fits, or a slot can't be filled, the
   answer goes back to Paul (`too_long`, `missing_slot`). `reuseNote(7)` is
   "reused from bank (used 7×)". A reuse is recorded once per application with one
   `answer.reused` event. `narrativeKindOf(canonicalId)` gives the kind the bank stores, and
   `null` for factual or unknown ids, so callers never bank a factual question.
4. **Events** carry ids, the canonical id, kind, version, match confidence, citation counts and
   the `edited` flag. Never the form's question text, the answer text or the company name.

## Acceptance criteria
- [ ] A saved answer needs a live approval by Paul of kind `answer`, subject `answer:<id>` and the
      exact content hash; a missing, rejected, undone, still-in-undo-window or mismatched
      approval stores nothing and returns the named error (db tests). A policy decision is
      refused too (`DecidedByPolicy`), though the Gate can't produce one for kind `answer` today.
- [ ] Saving the same answer twice stores one answer, one use and one event.
- [ ] A second approved answer to the same canonical question is version 2 and becomes the bank's
      answer; the use count covers both versions.
- [ ] Citing a draft story is refused; citing another candidate's story or atom is refused by a
      foreign key.
- [ ] `bank_answer`, `bank_answer_citation` and `bank_answer_use` refuse UPDATE and DELETE.
- [ ] Recording the same reuse twice stores one use and one event; events contain no answer text.
- [ ] `adaptAnswer` fills `{company}`, prefers the long text when it fits, falls back to the short
      one, and returns `too_long` / `missing_slot` instead of cutting or leaving a slot.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green on the PR.

## Failure modes
- **The Gate says no** (not found, rejected, undone, window open, content changed): nothing is
  stored; the caller shows the named reason. Fails closed.
- **The database is down:** the save throws; nothing half-written (one transaction). A retry with
  the same answer id is safe.
- **Two saves race for the same version number, or the same answer id:** a unique constraint
  fails one with a database error; a retry is safe.
- **A factual canonical id with a narrative kind:** `packages/db` can't import the canon
  (`packages/profile` depends on it), so it checks only the id's format and the kind list.
  Callers take the kind from `narrativeKindOf` and bank nothing it returns `null` for.
- **A hostile company name** (from job data): `adaptAnswer` fills `{company}` only with a plain
  short name (`unsafe_company` otherwise), because Paul approved the template, not the filled
  text.
- **A wrong but confident canonical match** (NS-118's lexical matcher): reuse puts a banked answer
  in front of Paul with its canonical question; narrative answers still go through approval
  (ANS-005) unless an APPLY-004 policy auto-approves the package with an exact reuse.

## Observability
Domain events `answer.approved` and `answer.reused` (aggregate `bank_answer:<id>`), written in the
same transaction as the rows. The save's Gate check emits the existing `approval.verify` span.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #59`)
- Answering factual questions from profile settings keyed by `FACTUAL_FIELDS` (ANS-001), showing
  Paul the canonical question and setting used: needs a profile settings table.
- The approval UI or CLI and the apply flow that calls these functions; drafting new answers
  (ANS-004), voice profile (ANS-007/008).

## Open questions
1. **Use count over all versions** of the canonical question rather than the newest version only:
   an edit starts a new version and shouldn't reset "used N×".
2. **No citation is required** by the database: "Why this role?" may cite nothing. The ANS-004
   provenance check will decide which answers must cite.

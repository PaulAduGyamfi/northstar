# NS-203 slice 6: Paul edits a waiting banked answer before approving it

Status: spec only, waiting on the orchestrator's decision (autonomous lane, ADR-0016)
Issue: #179 · Requirements: APR-002, ANS-004, ANS-005, ANS-006
Rules that apply: ADR-0002, ADR-0004, ADR-0016, `.claude/rules/db.md`

## What exists today (main at f4b9a0f)
- A banked answer is approved through the Gate as kind `answer`, subject `answer:<id>`, hash
  `answerContentSha256` (canonical id, kind, both texts, application). `saveApprovedAnswer`
  stores it once the approval verifies, and records an `edited` flag that the caller sets.
- **No answer draft is stored behind an `answer` request.** Reply edits have `reply_draft` and
  package edits have `application_package`, but answers have nothing like it. The draft text
  lives only with whoever filed the request, which today is nobody: `draftAnswer` has no
  caller, and only tests file `answer` requests.
- So there is nothing for an edit to read, nothing for the Queue to show, and nothing to check
  an edit against. The "edit" in `saveApprovedAnswer` (`edited: true`) assumes the caller
  re-files with Paul's text before he approves.

## Can the answer's provenance check run on Paul's own text?
Only in part. `validateAnswerDraft` needs every sentence to cite one of the given stories or
atoms and to quote it verbatim (at least `MIN_QUOTE_WORDS`). That works on a model's draft, but
Paul rewording a sentence breaks the verbatim quote, so the full check would refuse almost every
real edit.

The parts that do apply to Paul's own words are the ones the story check (`checkText`) and the
thesis check already run on his text:
- every number (digits, and number words such as "five") in the edited text appears in the cited
  items' quotes or in the original draft;
- every capitalised name (`names.ts`: mixed-case, digit-start and joined names, units through
  `unbackedUnits`) appears in them too;
- no invisible formatting characters, unusual spaces or lookalike letters (the reply check's rule);
- the edit keeps the original draft's citations: Paul can drop a sentence but can't add a cite.

## Proposed rule (the orchestrator decides)
An edited answer passes when all of these hold:
1. It is 1–`MAX_ANSWER` characters for each text.
2. It has no invisible or lookalike characters.
3. Each number and name in it is backed by the draft's cited quotes or the draft itself.
4. Its citations are a subset of the draft's.

It does not need a verbatim quote per sentence. Like an edited package, it is filed as a new
request that waits for Paul, so he approves exactly his own wording.

## What building it needs (two slices)
1. **Store answer drafts:** an append-only `answer_draft` table, one row per `answer` request.
   Its foreign key pins the request's id, kind and hash, as `reply_draft` does. It holds the
   canonical id, kind, both texts, the application, the cited story and atom ids, and each
   sentence's quote. `fileAnswerDraft` files the request and the row in one transaction from a
   `drafted` `draftAnswer` result. This needs a migration (0107).
2. **The edit:**
   - `editAnswerDraft` checks the rule above (code in `packages/profile`, run before the db
     call) and goes through `editRequest`. That means widening `approval_edit`'s allowlist and
     `EDITABLE_KINDS` to `answer`, in a migration (0107, or 0108 if slice 1 lands first).
   - The API's `GET /approvals/answer` and `POST /approvals/edit-answer`, and the Queue's
     "Show the answer" with Edit, built like the reply ones.
   - `saveApprovedAnswer` then reads `edited` from `approval_edit` rather than trusting the
     caller.

Together that is a schema change and likely over 300 lines, with no producer calling
`fileAnswerDraft` yet (draft filing waits for the answer bank's caller, NS-161 / the worker).

## Recommendation
Build slice 1 (storage) and slice 2 (edit) as separate PRs, or hold both until something files
answer requests. #179 stays open until then. The orchestrator's call.

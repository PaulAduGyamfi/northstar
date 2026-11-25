# NS-135: Answer-draft route that cites stories and atoms

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: ANS-004 (draft new narrative answers from retrieved stories and atoms, citing the
ones used; every sentence making a factual claim cites a story or atom, and uncited claims fail
validation). GitHub issue #60, parent #17 (NS-118).
Rules that apply: ADR-0004 (no fabrication), ADR-0006 (one model, explicit effort), ADR-0013
(request-keyed fixtures), ADR-0016 item 8 (hand-written fixtures, route off by default,
provisional baseline), AGENTS.md (code decides, the model drafts; untrusted text is data),
`.claude/rules/llm.md`, `.claude/rules/tests.md`.

## Why
Application forms ask narrative questions ("Tell us about a time you disagreed with a
decision"). The question canon (NS-118) recognises them, and the answer bank (GH-59) reuses
answers Paul approved, but a question with no banked answer has nothing to start from. The model
can draft one from Paul's approved stories and resume atoms, but only if every claim in it is
traceable to one of them, checked by plain code before Paul sees it.

## Behavior
All in `packages/profile/src/answer/`, plain code except the route.
1. **Evidence** (`evidence.ts`). An evidence item is a story or an atom: `{ id, kind, text }`.
   A story's text is its title and its four STAR parts; an atom's is its resume line.
   `selectEvidence(question, items, limit = 6)` ranks the items by how many of the question's
   content words (lower-cased, stop words dropped) they contain, and keeps the best `limit` with
   at least one shared word. Ties go to stories first, then by id. No model, no embeddings
   (NS-137 decides those). Reading stories and atoms from the database is the caller's job, so
   this ticket changes nothing in `packages/db`.
2. **Route** `answer-draft` (`route.ts`, prompt `packages/prompts/prompts/answer-draft/v1.md`).
   - Input: the question, an optional character limit, a voice guide (empty until the
     voice-profile follow-up, NS-136), and the selected evidence.
   - The question and the evidence go in `untrustedBlock`s: a form question comes from a job page,
     and stories hold Paul's pasted text. The voice guide also goes in one.
   - Output (`schema.ts`): `sentences`, each `{ text, cites: [{ id, quote }] }`, plus
     `followUps` (at most two questions for Paul when the evidence is too thin).
   - Effort `medium`, no tools.
3. **Validation** (`validate.ts`, `validateAnswerDraft(draft, evidence, limit)`), plain code.
   Failures name the sentence index and the problem, never the text:
   - every sentence cites at least one item, and each cited id is in the evidence given;
   - each cite's quote appears verbatim (after `normalize`) in that item's text;
   - every number in a sentence appears in that sentence's quotes;
   - every capitalised word in a sentence except its first word and "I" appears, as a whole word,
     in the text of an item it cites (no invented employers, tools or names);
   - with a limit, the joined answer fits it (never cut: too long fails);
   - at least one sentence.

   The rule is that **every** sentence cites, not only "claims". Plain code can't tell a claim
   from framing, so framing has to rest on evidence too. Company-specific questions ("Why us?")
   need uncited sentences, so they are out of scope.
4. **Off by default** (`draft.ts`, `draftAnswer(deps, input)`):
   - With `enabled: false` (the default for every caller until Paul records real fixtures), it
     returns `{ kind: "off" }` and calls nothing.
   - When on, it selects evidence and calls the gateway. Any outcome other than `Ok` (refused,
     truncated, invalid output) becomes `needs_human` with its reason.
   - An `Ok` draft is validated. A failing one becomes `needs_human` with its failures and is
     never returned as a draft.
   - It returns the call record for the caller's domain event. Nothing stores or sends.
5. **Eval** `evals/answer-draft/`: synthetic cases, a grader that runs `validateAnswerDraft` and
   each case's expectations, and **hand-written fixtures**, each marked
   `"handWritten": "NS-135 …"` with a `msg_handwritten_…` id.
   - The fixtures are written by `evals/src/sets/answer-draft-handwritten.ts` through
     `createRecordingClient`, so their request keys are the real ones.
   - One fixture deliberately cites a number its quote doesn't hold, so the grader is seen to
     fail it.
   - The baseline is **provisional**: it is the replay of the hand-written fixtures, not a model
     measurement.
   - A `needs:paul` issue asks Paul to `--record` real fixtures and run `--live
     --update-baseline`.

## Acceptance criteria
- [ ] A draft whose every sentence cites given evidence with verbatim quotes passes validation.
      An uncited sentence, an unknown id, a quote not in the item, a number not in the quotes, a
      capitalised name not in the cited items, and an over-limit answer each fail with their
      sentence index (profile tests; ANS-004's criterion).
- [ ] `selectEvidence` returns the items sharing the most question words, stories first on ties,
      and nothing for a question that shares no word (profile tests).
- [ ] `draftAnswer` returns `off` without calling the gateway when disabled. When enabled, it
      returns `needs_human` for a failing draft and for a refusal, and a validated draft
      otherwise (profile tests with a scripted gateway).
- [ ] The prompt is locked (`prompts.lock.json`). The route is registered, and `eval --all`
      replays `answer-draft` at its provisional baseline.
- [ ] A `needs:paul` issue to record real fixtures and set the baseline.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Model down, refusing or truncating:** `needs_human` with the reason. A transport error is
  thrown for the caller's retry (llm.md).
- **The model writes a claim the evidence doesn't support** in words with no number or name
  ("I led the team" from "we did it"). The validator can't catch the upgraded verb, so Paul's
  approval (ANS-005) is the backstop, the same limit as ADR-0004. The eval has a case for it.
- **Thin evidence:** follow-up questions, and every sentence still has to cite.

## Observability
`draftAnswer` returns the `CallRecord` and the outcome for the caller's domain event. No event is
emitted here, because nothing calls it yet.

## Out of scope
- Storing drafts or answers (the bank stores approved answers, GH-59), the approval flow, and
  any CLI or UI.
- Company-specific questions; the voice profile (NS-136); embeddings (NS-137).
- Real fixtures and the real baseline (Paul, via the `needs:paul` issue).

## Open questions
- Whether "every sentence cites" is too strict for good answers. The real-fixture eval will show
  it; loosening it would be Paul's call.

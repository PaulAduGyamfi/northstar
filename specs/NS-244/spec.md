# NS-244: One negation check for question confirming and package assembly

Status: draft (autonomous lane, ADR-0016)
Requirements: ANS-002, ANS-005 · ADR-0023
Rules that apply: `.claude/rules/tests.md`. Issue #285 (Parent: #251).

## Why
The same "is this question negated?" rule is written twice:
- `packages/profile/src/question-match.ts` exports `NEGATION`, which the matcher and
  `question-confirm.ts` use;
- `packages/pipeline/src/assemble.ts` keeps its own copy.

Each caller also normalizes the label (NFKC, curly quotes) itself. If one copy changes and the
other doesn't, a "Why would you NOT…" question could reuse a banked answer that says the opposite.

## Behavior
- `isNegatedQuestion(label)` in `@northstar/profile` normalizes the label, then applies the one
  `NEGATION` pattern.
- The matcher's factual check, `confirmQuestion` and `assemblePackage` all call it.
- The pipeline's own regex is deleted.
- No behavior changes.

## Acceptance criteria
- [ ] `grep -rn "NEGATION =" packages/*/src` finds one definition.
- [ ] A test shows `isNegatedQuestion` catches ASCII, curly-apostrophe and full-width negations,
  and leaves a plain question alone.
- [ ] Every existing negation test in `packages/profile` and `packages/pipeline` passes unchanged.

## Failure modes
None new: plain code, no I/O.

## Observability
None: no events or spans change.

## Out of scope
Changing which words count as a negation.

## Open questions
None.

# NS-233: Use the question confirm step in package assembly, never as auto-approvable reuse

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: ANS-002, ANS-005, APPLY-004 · ADR-0002, ADR-0017, ADR-0023.
GitHub issue #251 (Parent: #62).
Rules that apply: `.claude/rules/tests.md`, `.claude/rules/llm.md` (model output is checked by code).

## Why
NS-137's `confirmQuestion` lets the model pick a catalog question for a form question that code
left as new. Its match carries `confirmedBy: "model"`, but nothing enforces what that means. If
package assembly used it as an ordinary match, an ambiguous question (a lexical score of 0.86 in
NS-137's tests) would count as `bank_high_confidence`. Under `allowHighConfidenceAnswers`, a
mistaken or injected pick could then be auto-approved without Paul seeing it.

## Behavior
1. **`assemblePackage` takes an optional `confirmed` map** (`packages/pipeline`, `assemble.ts`):
   field name → `ConfirmedMatch`, which the caller computed with `confirmQuestion` beforehand.
   The assembly stays plain code with no model call (ADR-0023).
   - **Only a model's pick is used,** and only where it could be one: code's own match of the
     label left it new, and the pick is one of `confirmCandidates(label)`. Every other entry,
     including any `by: "rules"` entry, is ignored, and code matches the label itself. So a stale
     map or a mixed-up field name can never carry a match the label doesn't earn.
   - The same narrative-only and negation rules still apply. The negation check now runs on the
     normalized label (NFKC, curly quotes), as the confirm step's does, so "wouldn’t" and
     full-width letters are caught.
2. **`AnswerSource` (bank) gains `confirmedBy: "rules" | "model"`,** so Paul and the Gate can
   trace who chose the canonical question.
3. **The policy never counts a model-confirmed match as reuse.** `bankSource` returns `new` for
   `confirmedBy: "model"`, whatever its confidence or wording. It is never `bank_exact` or
   `bank_high_confidence`, so a model's pick always waits for Paul.
4. **`confirmQuestion` stays off** (`enabled` is false by default). Nothing turns it on until
   Paul records real fixtures.

## Acceptance criteria
- [x] A model-confirmed match fills the field from the bank, with `confirmedBy: "model"` in its
      source, and its policy source is `new`, even at a confidence ≥ 0.8 or with exact wording.
- [x] A rules entry, a pick for a label code already matches, and a pick outside the label's
      candidates are all ignored, and code's own match stands.
- [x] A negated label, including one with a curly apostrophe or full-width letters, is never
      answered from the bank, even when the map holds a match.
- [x] Without the map, every existing test passes unchanged.
- [x] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope
- The caller that runs `confirmQuestion` before assembly (NS-227's package caller).
- Importing `NEGATION` from `question-match.ts` instead of the copy in `assemble.ts`. It is
  exported from that file but not from `@northstar/profile`'s index, and adding it there would
  touch `packages/profile`, which another agent is changing now. Both copies are the same
  regular expression.

## Decisions (ADR-0016)
- **Confirmed matches are passed in, not computed.** The assembly stays pure (ADR-0023), and the
  model call stays in its caller.
- **The `NEGATION` de-duplication is deferred** (see Out of scope).

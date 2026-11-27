# NS-272: the package producer refuses disguised labels the Gate already counts as new

Status: in progress (autonomous lane, ADR-0016)
Issue: #421 (parent #297)
Requirements: ANS-003, APPLY-004
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/tests.md`

## Why
Since #420 the Gate's `labelReuse` (`packages/domain/src/question-reuse.ts`) counts a form label
holding invisible formatting characters (`\p{Cf}`), modifier letters (U+02B0–U+02FF) or Greek or
Cyrillic letters as `new`: such a label can hide a "not" from the matcher and the negation check.
`assemblePackage` (`packages/pipeline`) doesn't apply that rule, so for "Why would you nоt…" (a
Cyrillic о) it still drafts Paul's banked answer to what may be the opposite question.

## Behavior
- `packages/domain` exports `isDisguisedLabel(label)`, the check `labelReuse` already runs (it now
  calls the export; no behaviour change at the Gate).
- In `assemblePackage`, a label `isDisguisedLabel` refuses never gets a banked answer: it is
  `not_matched`, like a negated label. A required question goes to Paul (`NeedsHuman`); an optional
  one stays blank. The check covers a model's pick too, so a pick can't route around it.

## Acceptance criteria
- [ ] A required question with a disguised label (a Cyrillic о, a zero-width space, U+02BC, a Greek
      letter) and a matching banked answer is `NeedsHuman` with `not_matched`; an optional one is
      left blank (pipeline tests).
- [ ] A model's pick on a disguised label is ignored the same way (pipeline test).
- [ ] `isDisguisedLabel` answers as `labelReuse`'s rule did (domain tests); `labelReuse` unchanged.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- Factual answers on disguised labels (they already count as `new` at the Gate and come from
  Paul's settings, not the bank).
- Relaxing the Greek and Cyrillic rule (an open decision for Paul on #297; unchanged).

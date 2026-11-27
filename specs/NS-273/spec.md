# NS-273: the disguise rule catches other-script lookalikes and hidden marks, and the factual path refuses disguised labels

Status: in progress (autonomous lane, ADR-0016)
Issue: #423 (parent #297)
Requirements: ANS-001, ANS-003, APPLY-004
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/tests.md`

## Why
The security review of #422 found that `isDisguisedLabel` (`packages/domain/src/question-reuse.ts`)
misses Armenian "օ", Cherokee and Coptic letters, combining marks ("nót", which NFKC composes so
`\bnot\b` misses it), the grapheme joiner and variation selectors (Mn, not Cf). A label using
them passes both `isNegatedQuestion` and `isDisguisedLabel`, so the Gate counted "Why would you
nօt want to work at …?" as `bank_high_confidence` (checked with the real matcher). Also,
`assemblePackage` tried `answerFactual` before the disguise check, so "Are you legally nоt
authorized to work in Canada?" got "Yes" from settings.

## Behavior
- `isDisguisedLabel` also flags any nonspacing mark (`\p{Mn}`), the braille blank U+2800, and any
  letter outside the Latin, Common and Inherited scripts (it already flagged `\p{Cf}`, modifier
  letters, Greek and Cyrillic). Accented Latin letters, dashes and symbols stay allowed. The Gate
  (`labelReuse`) and the producer share it, so both change together.
- `assemblePackage` checks it first, before the factual path: a disguised label is `not_matched`
  whether it would have been answered from settings or the bank. No new reason code.

## Acceptance criteria
- [ ] `isDisguisedLabel` flags each new kind and leaves accented Latin, dashes and symbols alone;
      `labelReuse` counts the new kinds as `new` and an accented company's own wording as exact
      (domain tests).
- [ ] The producer sends the new kinds to Paul, and never answers a disguised factual label from
      settings (pipeline tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- A precomposed accent inside a Latin word ("nót" typed as U+00F3) is a Latin letter, so it isn't
  flagged; company names need such letters. Catching it would mean the negation check reading
  "not" through accents.
- Relaxing the Greek and Cyrillic rule (Paul's open decision on #297): this only makes it wider.

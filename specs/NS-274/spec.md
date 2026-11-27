# NS-274: a negation skeleton so the negation check reads through lookalike letters

Status: in progress (autonomous lane, ADR-0016)
Issue: #426 (parent #297)
Requirements: ANS-003, APPLY-004
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/tests.md`

## Why
The security review of #425 (NS-273) left three ways to hide a "not" that the disguise rule can't
refuse, because real labels and company names need the characters: a backtick or acute accent as
the apostrophe ("wouldn`t"), digits ("n0t", "w1thout", "n3ver"), and precomposed or other Latin
lookalikes ("nót", "nǫt", "nøt", "nꝋt", "noŧ"). Checked with the real matcher: on main the Gate
counted each of these "why this company" labels as `bank_high_confidence`.

## Behavior
- `negationSkeleton(label)` (`packages/domain/src/question-match.ts`): apostrophe stand-ins
  (`` ` ``, U+00B4) as `'`, then `normalize` (NFKC, curly quotes), then NFKD with every mark
  stripped, lowercase, then a small lookalike map (0→o, 1→i, 3→e, ø, ꝋ, ꝍ → o, ŧ → t, ı → i,
  ł → l).
- `isNegatedQuestion` is true when `NEGATION` matches either the normalized label (as before) or
  its skeleton, so it only ever finds more negations. The matcher, `confirmQuestion`, the
  producer (`assemblePackage`) and the Gate (`labelReuse`) all use it, so all of them refuse such
  labels. Only the negation test reads the skeleton: matching, scoring and company names are
  unchanged.

## Acceptance criteria
- [ ] `isNegatedQuestion` reads through each stand-in and lookalike; accented company names,
      digits in counts and ranges, and "notice" stay not negated (domain tests).
- [ ] `labelReuse` counts such labels as `new`; the producer never answers them from the bank
      (domain and pipeline tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- A full confusables table (Unicode TR39): the map covers the letters of "not", "no", "never" and
  "without" that survive NFKD and the disguise rule; others stay a follow-up if found.

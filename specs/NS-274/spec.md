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
  (`` ` ``, U+00B4, U+201B, U+2035, the saltillos U+A78B/U+A78C) as `'`, before and after
  `normalize` (NFKC, curly quotes; NFKC turns the full-width grave into a backtick), then NFKD with
  every mark stripped, lowercase, then a lookalike map: the digits 0, 1, 3, 7, and Latin letters
  with no decomposition that the disguise rule allows (ø ⱺ ꝋ ꝍ → o, ŋ ƞ ꞑ ꞥ → n, ŧ ƫ ƭ ⱦ → t,
  ɇ → e, ı → i).
- `isNegatedQuestion` is true when `NEGATION` matches the normalized label (as before), its
  skeleton, or the skeleton with everything but letters and spaces dropped ("n-o-t", "n@t" → "nt");
  or when that last form has "not" or "nt" glued to an auxiliary verb ("wouldnt", "dont",
  "cannot") or a lone "nt". Any reading counts, so it only ever finds more negations. The matcher,
  `confirmQuestion`, the producer (`assemblePackage`) and the Gate (`labelReuse`) all use it, so
  all of them refuse such labels. Only the negation test reads the skeleton: matching, scoring and
  company names are unchanged.

## Acceptance criteria
- [ ] `isNegatedQuestion` reads through each stand-in and lookalike; accented company names,
      digits in counts and ranges, and "notice" stay not negated (domain tests).
- [ ] `labelReuse` counts such labels as `new`; the producer never answers them from the bank
      (domain and pipeline tests).
- [ ] lint, typecheck, test, build green (CI `checks`).

## Out of scope
- A structural rule (count `bank_high_confidence` only when every word of the label belongs to the
  canonical question, the company or a fixed filler list): the security review showed a denylist
  can't be complete ("wouldn t", "ne ver", other lookalikes). It changes the policy's meaning, so
  it is a `needs:paul` follow-up.
- A full confusables table (Unicode TR39): the map holds the stand-ins found so far, not every
  possible one; the structural rule above is what would make the list unnecessary.
- Accent stripping reads "nó", "nô" and "Nö" as "no", so a label naming such a company goes to
  Paul: a false positive that fails closed.

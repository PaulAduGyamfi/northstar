# NS-277: high-confidence reuse needs every word of the label to be known

Status: in progress (autonomous lane, ADR-0016)
Issue: #441 (parent #297; decision on #429, option 2)
Requirements: ANS-003, APPLY-004 · ADR-0002, ADR-0017
Rules that apply: `.claude/rules/tests.md`, `.claude/rules/db.md`

## Why
The matcher drops filler and unknown words. A label can therefore reach a 1.0 match while
carrying a word that changes its meaning, and the negation and disguise checks can't list every
such word: a split "wouldn t", "ne ver", a lookalike letter the disguise rule allows, or an
extra ask. Before this change, such a label counted as `bank_high_confidence`, and an answer
reused on it could skip Paul's review.

## Behavior
- `isKnownWording(label, canonical, company)` (`packages/domain`, `question-reuse.ts`) is true
  only when every word of the label comes from one of these sources:
  - the canonical question's wording or examples (slots add no words);
  - the company's name, when `isSafeCompany`;
  - `KNOWN_FILLER`, a small list with no negation or modal words.
- A word is a run of letters, digits and apostrophes after NFKC and lowercasing, with a
  possessive "'s" dropped (`labelWords`).
- `reuseStrength` (the Gate's `labelReuse`) and the producer's `bankSource` both require it for
  `bank_high_confidence`. Anything else at that confidence becomes `new`.
- `bank_exact`, the negation check and the disguise check are unchanged.

## Acceptance criteria
- [ ] These labels count as `new`: "Why wouldn t you…", "Why would you ne ver…", a label with an
      unlisted Latin letter (ĸ), and a label with an extra ask (domain tests).
- [ ] An honest rewording made only of known words is still `bank_high_confidence` (domain and
      pipeline tests).
- [ ] No expected value loosens. Labels that tighten from `bank_high_confidence` to `new` are
      listed in the PR.
- Known limits (security review): a second ask built only from known words, and words from a
  company name `isSafeCompany` accepts ("Acme Your Salary Expectations", already exact on main),
  still pass. Both are follow-ups, not loosened here.
- [ ] lint, typecheck, test, build green; no migration.

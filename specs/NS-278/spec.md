# NS-278: a company name's words count for reuse only where the canon puts the company

Status: in progress (autonomous lane, ADR-0016)
Issue: #444 (parent #297; follow-up to NS-277's security review)
Requirements: ANS-003, APPLY-004 · ADR-0002, ADR-0017

## Why
The employer controls both the company name and the form label. `isSafeCompany` accepts a name
like "Acme Your Salary Expectations". Before this change:
- `isExactWording` counted "Why do you want to work at Acme Your Salary Expectations?" as
  `bank_exact`;
- `isKnownWording` credited each of the name's words anywhere in the label, so "Why do you want
  to work at Acme? Your salary expectations?" counted as `bank_high_confidence`.

## Behavior (both rules, in `packages/domain/src/question-reuse.ts`; the Gate and `assemblePackage` share them)
- `isReuseCompany(company)`: a name earns reuse credit only when it passes `isSafeCompany` and has
  at most 3 words (`REUSE_COMPANY_MAX_WORDS`) and 40 characters (`REUSE_COMPANY_MAX_LENGTH`). A
  longer name still fills an answer's `{company}` slot (`adaptAnswer` is unchanged), but earns
  neither `bank_exact` nor company-word credit.
- `isKnownWording` no longer credits the company's words one by one. It takes the whole name out
  where the label writes it, as one unit and in order (after NFKC and lowercasing, with nothing
  but punctuation or spaces at either end), at most as many times as one of the canonical
  wordings has a `{company}` slot (security review: a repeated name keeps its words). Apostrophes
  are folded as `labelWords` folds them; a copy joined to a word by an apostrophe ("you're" with
  the company "re") is never taken out, and a possessive "'s" goes with the name (review). The rest must be all known words, and the label must
  hold at least one word that isn't the name.

## Acceptance criteria
- [ ] With company "Acme Your Salary Expectations", "Why do you want to work at Acme? Your salary
      expectations?" and the exact wording both count as `new`.
- [ ] "Example Corp" still gets `bank_exact` and `bank_high_confidence` where it did; a stray "Corp"
      or the name alone is not known.
- [ ] No expected value loosens; tightenings listed in the PR. No migration.

## Known limit
A company name of 3 words or fewer that reads as an ask ("Acme Salary Expectations") still earns
credit. The cap trades this against real names; a stricter rule would need a list of ask words.

# NS-216: Exempt number-plus-unit tokens from the name rule

Status: autonomous (ADR-0016; Paul approved the change, including the assertion change)
Requirements: CPG-003, ANS-004 · ADR-0004. GitHub issue #203 (parent #177).
Paul's approval: "Sure" (2026-11-26), and his delegation "Anything needed from my use your
recommended choice", both recorded on #203.

## Why
NS-202 made any piece holding a capital a name. A count or size written with a capital unit
("1M users", "5GB", "200kW") then had to appear exactly as written in its sources, so a draft
saying "1M" where Paul said "1 million" became `needs_human`. Paul chose to exempt these.

## Behavior
1. **`nameParts`** (`packages/profile/src/names.ts`) no longer takes a piece that is digits
   followed by a known unit.
   - The units: K, M, B, KB, MB, GB, TB, PB, kW, MW, GW, dB, Hz, kHz, MHz, GHz.
   - Units with no capital ("10k", "200ms") were never names.
   - A decimal is already cut at the dot ("1.5M" gives "1" and "5M"), so "5M" is the piece
     tested.
2. **The scale must be backed too** (`unbackedUnits`, from the security review). A unit is a
   scale, so it must appear in the same sources as the digits: the same unit after a number
   ("1M", "5 GB", any case), or for K, M and B its word ("thousand", "million", "billion").
   - "5 thousand" can't become "5B", and "7 engineers" can't become "7M".
   - Single letters aren't scale words: an "m" that ends "I'm" backs nothing.
   - Only ASCII digits qualify. NFKC folds fullwidth digits, and digits from other scripts stay
     names (the number rule can't see them).
3. **The number rule still applies.** The token's digits must still come from the sentence's own
   quotes (answers), or from the part's quotes and the atom (stories). A "1M" can't appear unless
   a quote holds the number 1.
4. **Still names:** "2FA", "macOS", "iOS", "S3", "4G" and "5G" (G is not on the list), and
   all-caps acronyms.

## Decisions
- **"3M" is exempt, like "1M".** Issue #203 says "3M the company" stays a name, but it has the same
  shape as "1M users". Plain code can't tell them apart, and keeping it would undo the exemption
  Paul approved. An invented "3M" employer is still refused unless the cited quotes hold "3M"
  or "3 million", because the scale check requires it.
- **"GW" is added to the unit list** beside kW and MW. "ms", from the issue's list, has no capital
  and was never a name.
- **The NS-202 test changes.** "needs a unit written with a capital to appear as written" in
  `story-validate.test.ts` now expects "1M" to pass when the quotes say "1 million". Paul approved
  this change on #203.

## Acceptance criteria
- [ ] "We served 1M users." passes the story and answer checks when a quote holds "1 million".
- [ ] Each listed unit is exempt, and "2FA", "macOS", "iOS" and "S3" are still refused when
      unbacked (names tests).
- [ ] The number rule still refuses "7M" when no quote holds a 7.
- [ ] `eval --all` (CI): `story-draft` and `answer-draft` at or above baseline.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

# NS-201: A rejected story quote no longer backs its part's numbers

Status: approved (decision on #176; all four assertion changes approved on #236 under Paul's "You decide what's best")
Requirements: CPG-005 (story provenance), ADR-0004
Rules that apply: ADR-0004, ADR-0016

## Why
In `validateStoryDraft`, a part's allowed numbers came from all of its quotes, including quotes the
check had just rejected. The draft was refused either way, but the failure list left out the
number a bad quote smuggled in (for example "2%" cut out of Paul's "12%").

## Behavior
A part's digit numbers are allowed only from its quotes that pass (inside one answer, whole words
and numbers, at least two words) or from the resume line. Number words and units are unchanged.

## Acceptance criteria
- [x] The four tests named on #236 expect the extra `number … is not in its quotes or the atom`
      lines (`story-validate.test.ts` ×3, `interview.test.ts` failureCount 1 → 2).
- [x] `pnpm --filter @northstar/profile lint typecheck test` passes.

## Out of scope
Number words and units (`unbackedNumberWords`, `unbackedUnits`) still read all of a part's quotes.

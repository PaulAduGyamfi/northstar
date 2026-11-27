# NS-130 slice 12: postingText also removes blank-looking characters

Status: in review (PR)
Requirements: UX-014, NFR-SEC-004 (untrusted text is data)
Rules that apply: `.claude/rules/web.md`, `.claude/rules/tests.md`

## Why
#427's security review noted that `postingText` (`apps/api/src/career-directions.ts`), which
prepares every piece of posting text the Career DNA and jobs pages show, removes control and
formatting characters but not the blank-looking ones the independent-work checks already refuse.

## Behavior
`postingText` also removes the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the braille blank
(U+2800), the combining grapheme joiner (U+034F) and the variation selectors, the same set as
`INVISIBLE_IN_WORK` in `packages/profile`. Everything else is unchanged.

## Acceptance criteria
- [x] Each listed character is removed and words around it stay apart.
- [x] Letters (accented, Korean), digits and ordinary punctuation are untouched.
- [x] `apps/api` lint, typecheck and tests pass.

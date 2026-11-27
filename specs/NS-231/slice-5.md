# NS-231 slice 5: the database refuses invisible characters in independent work

Status: in progress (autonomous lane, ADR-0016; holds the `packages/db` migration lane)
Requirements: DX-010, NFR-SEC-004 · `.claude/rules/db.md` ("the database guards the data")
Issue #245. Slices 1–4: #296, #298, #304, #336. Item from slice 2's security review.

## Why
Since slice 3 `parseIndependentWork` refuses a title, line or link holding an invisible formatting
character (`\p{Cf}` such as U+202E or U+200B), a line or paragraph separator, or a blank-looking
character (Hangul fillers, the braille blank, the grapheme joiner, variation selectors). The
database doesn't, so a writer that skips the parser could still store one, and these lines go
verbatim into tailored resumes and LinkedIn copy.

## Behavior
- A new migration adds a CHECK to `independent_work_entry` (title, link) and
  `independent_work_line` (text) that refuses the same characters.
- Postgres regular expressions have no Unicode property classes, so the CHECK lists the characters
  by code point (`\uXXXX`, `\UXXXXXXXX`), from the Unicode `Cf` list plus U+2028, U+2029, U+115F,
  U+1160, U+3164, U+FFA0, U+2800, U+034F and the variation selectors.
- The constraints are added `NOT VALID`: they refuse new rows without failing the migration on a
  row stored before slice 3. Rows are append-only, so nothing old is ever rewritten.
- A test enumerates every code point the parser's pattern refuses and checks the database refuses
  each one too, so the two lists can't drift apart unnoticed. Ordinary text (letters, accents,
  emoji, CJK, a byte-order-free line) still stores.
- No new writer, event or grant: the tables exist; `northstar_grant_app_role()` isn't needed.

## Acceptance criteria
- [ ] Inserting a title, link or line with any character the parser refuses fails on the CHECK.
- [ ] Every code point the parser's pattern matches is refused by the database (test).
- [ ] Ordinary text still stores.
- [ ] `pnpm turbo run lint typecheck test build` passes in `packages/db` (and dependents typecheck).

## Out of scope
- The thesis surfaces; requiring every stored entry.

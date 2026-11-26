# NS-231 slice 3: refuse invisible formatting characters in independent work

Status: building (autonomous lane, ADR-0016)
Requirements: DX-010
Rules that apply: ADR-0004, NFR-SEC-004, `.claude/rules/tests.md`.
Issue #245 (Parent: #167). From slice 2's security review (optional item).

## Why
Paul's independent-work lines go verbatim into tailored resumes and LinkedIn copy. The parser
already refuses control characters (`\p{Cc}`), but not invisible formatting characters
(`\p{Cf}`): a right-to-left override (U+202E) can make a line read differently from what is
stored, and a zero-width space (U+200B) can hide inside a word. Pasted text carries them more often
than people notice. They should be refused when the file is read, so nothing stores them.

## Behavior
- **`parseIndependentWork`** refuses a title, a line or a link that holds any `\p{Cf}` character,
  with its own message ("… can't hold an invisible formatting character"), the same way as any
  other bad line: the file returns every problem and nothing is stored.
- **A byte-order mark at the very start of the file** (U+FEFF, which some editors save) is not
  part of the first header: it is dropped before parsing, so a saved file isn't refused on line 1.
  A U+FEFF anywhere else is refused like any other formatting character.

## Out of scope
- The database check on stored rows: it needs a migration, and `ns-237` holds `packages/db`.
- The other files Paul gives (`site.ts`, `growth-file.ts`): their own issues, if wanted.

## Acceptance criteria
- [ ] A title, a line and a link with U+202E, U+200B or U+2060 are each refused with the new
      message and the line's number.
- [ ] A file starting with U+FEFF parses exactly as without it.
- [ ] A U+FEFF inside a line is refused.
- [ ] `pnpm turbo run lint typecheck test build --filter=@northstar/profile` passes.

# NS-227 (slice 3): Paul's contact details for application packages

Status: built
Requirements: APPLY-001 (the package carries the applicant's contact), ANS-001 (Paul's own data,
never guessed)
Rules that apply: ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`. Parent: #112, issue
#235 item 2 ("Paul's contact and factual settings").

## Why
An `ApplicationPackage` needs `contact` (first and last name, email, an optional phone), and the
Apply Gateway's adapters type them into the form's standard fields. Nothing stores them: the
profile settings are answers to canonical factual questions, and a test requires their field list
to match the question canon's, so contact details don't belong there. The package caller (slice 4)
needs them first.

## Behavior
- **`profile_contact`** (`packages/db`, `contact-schema.ts`, migration): one row per change, the
  newest current. First and last name (1-100 characters), email (at most 254), phone (1-40 or
  null). CHECKs refuse empty values and control characters. Append-only (trigger).
- **`setContact`** (`contact-write.ts`): checks the shape with the package's own contact schema
  (`ContactDetails`, from `ApplicationPackage` in `packages/domain`), so a stored contact always
  fits a package. Saving what the current row already holds stores nothing. Writes
  `profile.contact_set` with fixed words and a phone flag only: never a name, email or number.
  `readContact` gives the current one or null.
- **Command** `profile contact set --first <name> --last <name> --email <address> [--phone
  <number>]` and `profile contact show` (its own usage line). Every field is given each time,
  so a dropped phone is removed on purpose, never by leaving it out by accident. Paul only: it
  prints his own details back to him.

## Plan and tasks
1. `ContactDetails` exported from `packages/domain` (the `contact` part of `ApplicationPackage`).
2. Schema, migration (generated table; custom append-only trigger and app-role grant).
3. `setContact`, `readContact`, with PGlite tests.
4. `contact-cli.ts`, wired in `cli.ts` and `bin.ts`, with CLI tests.
5. Docs: AGENTS.md (package note and command row), `.claude/rules/db.md`.

## Acceptance criteria
- [x] A contact is stored once, unchanged saves store nothing, the newest is current, a bad one
      is refused with nothing stored, the table is append-only, and the event carries no
      contact text (PGlite).
- [x] `profile contact set|show` stores and prints it, says why it refuses, and prints its own
      usage for a bad command (CLI tests).
- [x] `pnpm turbo run lint typecheck test build` passes.

## Decisions made without Paul (ADR-0016)
- Schema change: a new table, rather than four new profile-setting fields (those are answers to
  canonical questions, and the two lists must match).
- Diff size: about 590 added lines without the generated snapshots and journal, over the ~300
  guide; about 290 without the tests and docs. The table is no use without its writer and the
  command that fills it, so they stay one slice.

## Out of scope (rest of #235)
- The caller that assembles and files a package (slice 4): it reads the contact with
  `readContact`.

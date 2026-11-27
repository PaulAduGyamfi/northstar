# NS-249 slice 2: the question canon and its matcher move to `packages/domain`

Status: built (autonomous lane, ADR-0016). Assigned by the orchestrator.
Issue: #297 item 2 (parent #195). Decision on #297 (2026-11-27, delegated by Paul): move the
canon and its pure matcher to `packages/domain` with no behaviour change, keep re-exports from
`packages/profile`, then add the Gate's check. Item 2 lands in two PRs: this move, then the check
(slice 3).
Requirements: ANS-001, ANS-002, APR-004, APPLY-004 · ADR-0002, ADR-0017
Rules that apply: `.claude/rules/tests.md`

## Why
The Gate (`packages/db`) must check that a banked answer's `canonical_id` fits the form question
it fills, by the form label's own match. The canon and matcher live in `packages/profile`, which
`packages/db` can't import. They are plain code with no I/O, so they belong in `packages/domain`.

## Behavior
- `question-canon.ts` and `question-match.ts` move from `packages/profile/src` to
  `packages/domain/src` unchanged, with `question-match.test.ts`. The text `normalize` they use
  moves with them (`packages/domain`, `text-normalize.ts`), and `packages/profile`'s `validate.ts`
  re-exports it, so every profile caller keeps its import.
- `packages/profile` keeps `question-canon.ts` and `question-match.ts` as re-export files, and
  its index exports the same names as before: no import anywhere changes.
- `packages/domain`'s index exports the canon and the matcher's public names.
- No behaviour, test assertion or threshold changes.

## Acceptance criteria
- [x] The moved tests pass in `packages/domain`, unchanged apart from import paths.
- [x] `packages/profile`'s exports are the same names, from the same module path.
- [x] lint, typecheck, test and build green for domain and every package that imports it; docs.

## Out of scope
- The Gate's per-answer canonical check (slice 3).

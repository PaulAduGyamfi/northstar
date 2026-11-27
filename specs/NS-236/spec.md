# NS-236: dead-letter kinds come from a fixed list

Status: in progress (autonomous lane, ADR-0016)
Requirements: RES-007, OBS-001 · Issue #261 (parent #200, item 3 of the NS-175 security review)

## Why
`recordDeadLetter` accepts any dotted name that matches `NAME_PATTERN`. A producer could build a
kind from data, and the kind goes into the `dead_letter.recorded` event's reason and payload and
into the span, so it could carry a company's or a person's name into the feed. Producers pass
constants today; the write path should hold them to it.

## Behavior
- `packages/db` exports `DEAD_LETTER_KINDS = ["apply.stale_sweep", "apply.submission"]` (the
  NS-220 sweep and the NS-226 submission ending, the only producers) and `DeadLetterKind`.
- `recordDeadLetter` refuses any other kind with `InvalidDeadLetter` (field `kind`) and stores
  nothing, before the pattern check matters.
- A new producer adds its kind to the list in its own ticket, with its words in
  `apps/web/src/dead-letters.ts`.
- Existing tests move from the invented kinds `apply.submit` and `llm.route:story-draft` to listed
  kinds (Paul's OK on #261); each test still checks the same behavior.
- No migration: the database's own CHECK stays the name pattern (the list lives in code).
- `apps/web/src/dead-letters.ts` gets words for `apply.submission` (and the `activity_failed`
  reason) that never claim a restart: resolving a letter only records Paul's choice today.

## Acceptance criteria
- [x] Both producers' kinds record.
- [x] A well-formed but unlisted kind (`apply.submit`) is refused with field `kind`, nothing stored.
- [x] Existing tests pass on listed kinds with unchanged behavior.
- [x] `pnpm turbo run lint typecheck test build` passes in `packages/db` and its dependents.

## Out of scope
- A database CHECK on the list (needs a migration).

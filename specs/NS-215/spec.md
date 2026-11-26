# NS-215: The dead-letter view in the app and its first producer

Status: draft
Requirements: RES-007 (dead letters are visible and resolvable), ADR-0007, UX-043 (keyboard-
reachable buttons)
Rules that apply: ADR-0016, `.claude/rules/db.md` (dead letters), `.claude/rules/web.md`,
`.claude/rules/tests.md`. Parent: #126. Builds on NS-175 (the store) and NS-220 (its first
producer, the stale-claim sweep).

## Why
Work that exhausts its retries becomes a dead letter (NS-175), and the stale-claim sweep already
records one when a pass keeps failing (NS-220). But nothing shows them to Paul or lets him act,
so a letter waits unseen. And a kind is any dotted name a producer passes, which could one day
carry a company or person's name into events and spans.

## Behavior
- **Allowlist: not in this slice.** Limiting `recordDeadLetter` to a fixed list of kinds would
  change existing assertions in `dead-letter.test.ts`, which record and expect the invented kinds
  `apply.submit` and `llm.route:story-draft`. An assertion change stops for Paul (ADR-0016), so it
  is a `needs:paul` follow-up. Until then the page shows an unknown kind as itself, in words.
- **API** (`apps/api/src/dead-letters.ts`, `auth: "session"`):
  - `GET /dead-letters`: the open letters, oldest first: id, kind, reason code, attempts, time.
    The subject is left out: it names a row, which the page has no use for.
  - `POST /dead-letters/resolve` `{ deadLetterId, action }` (`retry`, `skip`, `hand_off`):
    resolves once as Paul (`actor: "user"`, whatever the body says), and answers what happens
    next. `not_found` (404), `already_resolved` (409).
- **What happens next** for `apply.stale_sweep`:
  - retry: the sweep runs again by itself every 5 minutes, so it picks the stuck claims up on its
    next pass;
  - skip: nothing more is done about this pass;
  - hand off: the claims it couldn't close stay in the Apply ledger for Paul to look at.
- **Web** (`/health`, a "Stuck work" section, `src/dead-letters.ts`): each letter's kind and
  reason in words, the attempts and when it stopped, and Retry, Skip and Hand off buttons
  (keyboard-reachable). After a click, the answer's "what happens next" line shows and the list
  reloads. None open: "Nothing is stuck."

## Acceptance criteria
- [ ] The API lists open letters without the subject, resolves as Paul whatever the body says,
      and maps not found and already resolved (API tests); 401 without a session.
- [ ] Every kind on the list has words and a next-step line for each action (web test), and an
      unknown kind still renders in words.
- [ ] `pnpm turbo run lint typecheck test build` passes.

## Failure modes
- API down: the Health page already says the API isn't answering; the section isn't shown.
- Postgres error on resolve: 503; the button says try again. A resolve is once only, so a retry
  after a timeout answers `already_resolved`, which the page treats as done.

## Observability
`dead_letter.resolved` (existing) with `actor: "user"`; the API's `api.request` span.

## Out of scope
- Running the sweep at once on retry (it runs every 5 minutes; an on-demand run needs the
  worker process, #230).
- Other producers and their kinds.
- The kind allowlist (the `needs:paul` follow-up above).

## Open questions
- None.

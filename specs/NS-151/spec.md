# NS-151: Persist verification windows (slice 1: the store and a store-backed catcher)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: VER-001, VER-002, VER-005, VER-006 · ADR-0010 item 4, ADR-0012.
GitHub issue #92 (parent #22). Blocker #23 (NS-124) is closed.
Rules that apply: `.claude/rules/db.md`, `gateways.md`, `tests.md`.

## Why
NS-123's catcher keeps verification windows and used message ids in memory. The process that
reads mail and the gateway that waits for a code are not always the same process, and a restart
loses every open window. So the windows need a home in the database that both can share, with the
same rules: single use, ambiguity refused, one resend, then `needs_human`.

## Behavior
1. **Tables** (`packages/db`, `verification-schema.ts`), append-only (triggers), written only
   through `verification-write.ts`. They store no code, link, subject, body or sender address.
   - `verification_window`: one row per window, with its candidate, tenant, ATS, purpose, sender
     domains, link hosts, duration, and opened and expiry times.
   - `verification_window_restart`: at most one per window (the one resend, VER-006), with the
     new opened and expiry times.
   - `verification_window_close`: at most one per window, with its reason (`verified`,
     `link_host_not_allowed`, `ambiguous_content`, `message_too_large` or `no_email`).
   - `verification_used_message`: a Gmail message id given to a window. It is unique per
     candidate, so one email serves at most one window, across processes.
2. **The store** (`dbWindowStore(db, candidateId)`): open, read the open windows, claim a
   message, restart once, close once. The database decides each race through a unique
   constraint, never a read-then-write.
   - A claim that loses returns false.
   - A second restart or close returns false, and a window closed by another process stays
     closed.
3. **Events** (VER-005), one per outcome, written in the same transaction as the close or
   restart:
   - the types are `verification.verified`, `verification.resend` and
     `verification.needs_human`;
   - the payload is the window id, tenant, ATS, purpose and outcome only;
   - feed lines read "Verified email for Acme (Workday)" and "Couldn't verify email for Acme
     (Workday): needs your hands".
4. **`createStoredCatcher`** (`packages/inbox`, `verify/stored-catcher.ts`): the catcher's
   `open`, `offer`, `offerAssisted` and `timeout`, but async over that store. Matching, extraction
   and the link check are the same code as `createCatcher`, moved into shared pure helpers
   (`verify/window-rules.ts`).
   - **Matching:** a message matches only from an allowlisted, Gmail-authenticated sender, inside
     the window. Two matching windows means neither gets it.
   - **Claiming:** the message is claimed before anything is extracted. A lost claim is
     `not_verification`.
   - **Results:** a code or link comes back only after the store closed the window for this
     call. A lost close is `not_verification`, so two processes can never both hand out a result.
   - **Timeout:** wait, then resend once (the window restarts), then `needs_human` (`no_email`).
5. **`createCatcher` keeps its behavior.** Only its internals now call the shared helpers.

## Acceptance criteria
- [ ] PGlite:
  - a message id is claimed once;
  - a window restarts once and closes once;
  - a closed window is no longer open;
  - a restarted window reads its new times;
  - every table refuses UPDATE and DELETE.
- [ ] PGlite: each close or restart writes its one event, with ids, tenant, ATS, purpose and
      outcome only, and the feed line above.
- [ ] Stored catcher, on a store with the same contract:
  - verified once;
  - the same message twice is `not_verification`;
  - two matching windows use neither;
  - a forged sender doesn't match;
  - a link to another host goes to `needs_human`;
  - wait, then resend, then `needs_human`;
  - a close lost to another process is `not_verification`.
- [ ] The existing catcher tests pass unchanged.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The database is down:** every store call throws, and the caller's step fails. No code is
  handed out without a claim and a close.
- **Two processes:** the unique constraints settle every race. The loser gets
  `not_verification`, or for `timeout`, the window's current state.

## Observability
- The same `verification.catch` spans as `createCatcher`: ids and outcome only.
- The three events above.

## Out of scope
- **The caller.** The gateway session that opens windows and polls (NS-142's browser driver)
  wires `createStoredCatcher(dbWindowStore(db, candidateId))`. Until then nothing uses it.
- **Gmail labels and archiving (VER-005).** They need `gmail.modify` (#238).

## Decisions (ADR-0016)
- **A schema change:** four new tables and their append-only triggers (one migration pair).
- **No new package dependency:**
  - `packages/inbox` defines the `WindowStore` shape, and `packages/db` implements it
    structurally.
  - The rules are tested in `packages/inbox` on an in-memory store with the same contract.
  - The races and events are tested on PGlite in `packages/db`.
- **The diff exceeds ~300 lines**, because the tables, store, catcher and tests come as one
  coherent slice.

# NS-121: Human handoff (slice 1: record, list and resolve "needs your hands")

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: APPLY-006 (on a CAPTCHA, login wall, MFA or account step: pause, notify, open the
exact page in Paul's browser, resume tracking after he finishes), ACC-007 (challenges hand off).
GitHub issue #20. Pre-filling the page through the extension is split into a follow-up issue.
Rules that apply: ADR-0002 (only Paul's session acts), ADR-0003 (no evasion: a challenge is
always Paul's hands), ADR-0012 (events in the same transaction), `.claude/rules/gateways.md`,
`.claude/rules/db.md` (append-only, events carry ids and codes, never URLs), `.claude/rules/web.md`.

## Why
The Apply Gateway already stops at a challenge with a `needs_human` reason (NS-120), but nothing
tells Paul or takes him to the page, and nothing records when he finishes it by hand. This slice
makes the handoff a visible item with a one-click link and a way to close it.

## Behavior
1. **Storage** (`packages/db`, one migration, append-only by trigger):
   - `apply_handoff`: one row per submission stopped by a challenge: the submission, the apply URL
     (https only, by CHECK), and when.
   - `apply_handoff_done`: at most one row per handoff: `submitted` or `gave_up`, and when.
2. **Writing it:** `recordNeedsHuman` takes the apply URL. When the reason is a challenge
   (`captcha`, `login`, `mfa`, `account`), it stores the handoff in the same transaction as the
   `needs_human` row, with a `handoff.opened` event (submission, application, ATS and reason; never
   the URL). Other reasons store no handoff (nothing Paul's hands can finish there).
3. **The gateway** (`packages/gateways`, `submit.ts`) passes the package's apply URL to
   `recordNeedsHuman`. Nothing else changes: no retry, no solving (ADR-0003).
4. **Reading and resolving** (`handoff-write.ts`):
   - `listOpenHandoffs`: open handoffs, oldest first, with the apply URL.
   - `resolveHandoff(handoffId, outcome)`: stores the outcome once with a `handoff.resolved`
     event. Resolving again returns the stored outcome and writes nothing.
5. **API** (`apps/api`, `auth: "session"`): `GET /handoffs`, and `POST /handoffs/resolve
   { handoffId, outcome }`. For `submitted`, the API then moves the application from
   `needs_human` to `submitted` through `transitionApplication`, keyed
   `application:<id>:handoff:<handoffId>:submitted`, so a retry never moves it twice.
6. **Web** (`apps/web`): a "Needs your hands" card on Today, with each open handoff's ATS and
   reason in plain words, an "Open the page" link (new tab, `noopener noreferrer`, https only),
   and "I submitted it" / "I gave up" buttons.
7. Feed lines for `handoff.opened` and `handoff.resolved` (`packages/domain`, `feed.ts`).

## Acceptance criteria
- [ ] A challenge during submission stores a handoff with the apply URL in the same transaction
      as `needs_human`, and the event carries no URL (db test on PGlite, gateway test).
- [ ] A non-challenge `needs_human` stores no handoff.
- [ ] An apply URL that isn't https is refused by the database.
- [ ] Handoff rows can't be updated or deleted.
- [ ] Resolving stores one outcome; resolving again writes nothing more.
- [ ] `GET /handoffs` and `POST /handoffs/resolve` refuse a request without a session.
- [ ] "I submitted it" moves the application to `submitted` once, even when sent twice.
- [ ] The Today card shows open handoffs with an https link only (web test of the plain logic).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The status move fails after the outcome is stored:** the handoff is closed and the API
  answers 500. Sending it again finds the stored outcome and retries the move under the same
  idempotency key.
- **Nothing produces a real challenge yet:** there is no browser driver until NS-142. Tests use
  the fake driver.

## Out of scope (follow-up issues, `agent-filed`, `Parent: #20`)
- Pre-filling the form in Paul's browser through the extension (needs stored packages, NS-161).
- A push notification for a new handoff (APR-003 surfaces).

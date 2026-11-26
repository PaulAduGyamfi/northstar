# NS-165: Unified job inbox view (slice 1: linked threads by application)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: INB-006 (unified job inbox view), INB-008 (origin badge in the app) · ADR-0018.
GitHub issue #116. Blockers #107 (NS-156) and #115 (NS-164) are closed.
Rules that apply: `.claude/rules/db.md`, `web.md`, `api.md`, `tests.md`.

## Why
Linked job mail is stored (`mail_link`, NS-158), but Paul can't see it anywhere. INB-006 asks for one
place that shows his job threads grouped by application, so he can see which application heard
back without opening Gmail.

## Behavior
1. **`readInboxThreads(db, candidateId)`** (`packages/db`, `inbox-read.ts`, read-only), from
   `mail_link` rows.
   - **Linked threads** are grouped by application, newest message first. Each application has
     its job title, company, status and origin (`readOrigin`).
   - Each thread has its Gmail thread id, the number of linked messages, the newest message's
     time, how it was linked (`tag`, `thread` or `sender`), and whether any message's sender was
     verified (INB-011).
   - **Queued threads** (the confirm queue) form their own group, with the queue reason.
   - No subject, sender, address or body: those are never stored.
2. **Classification:** linked mail's kind isn't stored yet. The mail-link loop (#224) will store
   it, so each thread carries `kind: null` and the page says "Not classified yet".
3. **`GET /inbox`** (`apps/api`): session only, with a Zod-checked output. Each thread links to
   Gmail by thread id (`https://mail.google.com/mail/u/0/#all/<threadId>`), a URL built from a
   checked id.
4. **`/inbox`** (`apps/web`): a read-only page grouped by application.
   - It shows each application's title, company, status and origin badge ("Started by Northstar
     · auto-approved", "Outside Northstar").
   - Each thread shows its message count, last received, how it was linked, "sender not
     verified" when so, and the classification.
   - It has a "Needs you to link it" group and a nav entry.

## Acceptance criteria
- [ ] PGlite:
  - two applications' synthetic threads come back grouped and newest first, with counts, steps,
    verified flags, origin and names;
  - queued mail comes back in its own group with its reason;
  - another candidate's rows never appear.
- [ ] API:
  - `GET /inbox` without a session is 401;
  - with one, it returns the groups;
  - a thread id that isn't a Gmail id is dropped, never put into a link.
- [ ] Web: the view model renders the groups, the origin badge words, "Not classified yet" and
      "sender not verified" (unit tests on the plain functions).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope
- Storing classifications, the mail loop and status proposals (#224).
- Gmail labels (#238).
- Opening a thread's text in the app: bodies are never stored (NFR-SEC-005).

# ADR-0031 — Approved prep blocks go to a Northstar calendar with `calendar.app.created`, through the Gate

**Status:** Proposed · **Date:** 2026-11-27

## Context
CAL-003 asks Northstar to schedule prep before each interview: by default two 45-minute blocks in
the 3 days before and a 15-minute warm-up an hour before. Paul approves the plan once per
interview, and the blocks then appear on his calendar. CAL-001 asks for events on a dedicated
"Northstar" calendar. ADR-0026 kept Calendar read-only and deferred writes to their own decision.
It named `calendar.app.created` with a Gate approval per write as the leading option.

What exists now:
- `planPrepBlocks` (`packages/domain`, NS-170) works out the blocks.
- `proposeInterviewPrep` (`packages/db`, NS-241 slice 1) stores one proposal per confirmed,
  current interview: `interview_prep_proposal` and its `interview_prep_block` rows.
- The Gate has a `prep_plan` kind (`APPROVAL_KINDS`, `packages/domain/src/approval.ts`) that
  nothing files yet.
- Nothing writes to Calendar.

ADR-0002 puts every write under Paul's name behind the Gate, and gateways refuse a call without a
live approval. ADR-0014 and ADR-0026 keep Google tokens in memory for one run, with no refresh
token. ADR-0025 (Gmail drafts) is the model for a narrow write scope held by one gateway module.

## Decision
1. **Scope: `https://www.googleapis.com/auth/calendar.app.created`.** It lets the app create
   secondary calendars and manage the events on calendars it created, and nothing else.
   - Northstar creates one calendar, "Northstar", and writes prep blocks only there.
   - It can't read, change or delete Paul's other calendars or events, including his primary
     calendar and any interview invite, whatever a bug or an injected invite tries.
   - The read scope (`calendar.events.readonly`, ADR-0026) stays on its own consent and token.
2. **Token: ADR-0014's model, in a Calendar Gateway module.**
   - `packages/gateways/src/calendar/` holds the only write code, in its own OAuth flow (desktop
     PKCE, loopback redirect, `access_type=online`).
   - It asks for exactly `calendar.app.created` and refuses a grant of anything else.
   - The access token lives in memory for one run, as its own type (`CalendarWriteAccess`), which
     never stands in for the reader's `CalendarAccess`. No refresh token is stored.
   - Like `src/mail/`, nothing outside the module imports its token or consent files (a boundary
     test). Its requests pass a runtime allowlist and the `calendar` breaker, and a new
     `calendar_writes` kill switch.
   - Because the token lasts one run, the write happens when Paul runs a command (as `funnel
     interviews` reads today). Writing on its own, in the worker, would need a stored refresh
     token: that is #400's decision.
3. **Approval: one `prep_plan` request per proposal (CAL-003's "approves the plan once per
   interview").**
   - The subject is `prep_plan:<proposalId>`. The request is filed from a stored
     `interview_prep_proposal` only, never from caller-built blocks.
   - The content hash covers the proposal id, the detection id and version, the calendar's fixed
     name, and each block's kind, start, end and fixed title ("Interview prep" / "Interview
     warm-up"). It covers no company or interviewer name: event text holds fixed words only (an
     open question below).
   - Paul approves or rejects the whole plan. Changing a block means a new proposal and a new
     request, not an edit.
4. **The writer acts only on a live approval, at the moment it acts.**
   - It calls `verifyApproval` (`prep_plan`, the subject, the re-computed hash) first, as the Apply
     Gateway and the draft writer do.
   - Inside the undo window (`effectiveAt`), the Gate's refusal carries `retryAt`, and the writer
     writes nothing until then.
   - Before writing, it checks that the proposal's detection is still the current version and
     still confirmed. A detection that a reschedule replaced, or that Paul dismissed, makes the
     writer withdraw the approval (`withdrawApproval` by `gateway`), write nothing, and leave a new
     proposal to the next run.
5. **Writes are safe to repeat (RES-006).**
   - Each block's event gets a client-chosen event id, derived from the Gate decision id and the
     block's index: lowercase base32hex, which `events.insert` accepts. A repeated insert answers
     409, which counts as already written, so a retry never makes a second event.
   - The writer claims each decision in a ledger before calling Google (like `reply_draft_claim`)
     and records the event ids after. Ids and times only, never event text.
   - The "Northstar" calendar is created once, with `calendars.insert`. Its id goes in the ledger,
     and after an unknown outcome the writer looks for it in the calendar list before creating
     another.
6. **The only Google writes are `calendars.insert` and `events.insert`** on the Northstar
   calendar. The writer names no update, patch, move or delete. A boundary test fails if any URL
   or client method under `src/calendar/` does. Paul removes or moves a block in Google Calendar
   himself.
7. **Visible in the feed (OBS-001).** One event per written plan carries the proposal and decision
   ids and the block count, never a title or time zone. Its feed line is fixed words, e.g. "Added
   3 prep blocks to your Northstar calendar". A write that fails all its tries becomes a dead
   letter with its own kind.
8. Paul adds the scope to the Google OAuth client's consent screen himself. Until he does, the
   writer reports `needs_human` (`scope_missing`). No code requests the scope until Paul accepts
   this ADR.

## Alternatives considered
- **`calendar.events.owned`.** It manages events on every calendar Paul owns, primary included.
  Blocks could then land on his primary calendar and count as busy to people booking him, which
  is a real benefit. But a bug or a misused token could also change or delete his own events
  there.
- **`calendar.events`.** Read and write on every event of every calendar Paul can reach. Far wider
  than prep blocks need (NFR-SEC-002).
- **One approval per block.** CAL-003 says Paul approves the plan once per interview, and three
  approvals for one plan add clicks without adding safety: the hash already pins every block.
- **No ledger, relying on 409 alone.** The client-chosen event id makes an event's insert
  idempotent, but creating the calendar has no such id, and a crash between the inserts would
  leave the plan half written with nothing recording it.
- **Write from the worker on a schedule.** It needs a stored refresh token, which ADR-0014 and
  ADR-0026 refuse until #400 decides it.

## Consequences
- + The writer can't touch any event Paul didn't approve, or any calendar Northstar didn't
  create.
- + A retry, a crash or a double run writes each block once.
- − Blocks on a secondary calendar don't make Paul's primary calendar look busy. People booking him
  through his primary calendar won't see them unless he shares the Northstar calendar's free/busy
  or checks for conflicts himself.
- − Paul runs a command (and consents) to write an approved plan, until #400 decides on a stored
  token.
- − A moved or removed block in Google Calendar isn't noticed by Northstar. The writer only ever
  inserts.
- Northstar must keep the boundary tests and the allowlist current whenever the writer changes.

## Open questions
- Should event titles name the company ("Prep: Initech interview")? That's more useful, but it
  puts a company name in Google's copy of the event. This ADR keeps fixed words.
- CAL-004's reminders belong on the interview itself, an event this scope can't touch. Should the
  warm-up block carry the hour-before reminder instead, or should reminders stay in Northstar's
  own notifications?
- Google's consent screen shows `calendar.app.created` as a sensitive scope. Paul should check it
  is offered for this OAuth client before accepting.

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
token. This ADR deliberately narrows ADR-0026 item 6's "approval per write" to one approval per
plan, as CAL-003 asks. ADR-0025 (Gmail drafts) is the model for a narrow write scope held by one gateway module.

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
   - Like `src/mail/`, nothing outside the module but the package entry imports its token or
     consent files (a boundary test). Its requests pass a runtime allowlist and the `calendar` breaker, and a new
     `calendar_writes` kill switch.
   - Because the token lasts one run, the write happens when Paul runs a command (as `funnel
     interviews` reads today). Writing on its own, in the worker, would need a stored refresh
     token, which ADR-0026 leaves to Paul; #400 asks him that question.
3. **Approval: one `prep_plan` request per proposal (CAL-003's "approves the plan once per
   interview").**
   - The subject is `prep_plan:<proposalId>`. The request is filed from a stored
     `interview_prep_proposal` only, never from caller-built blocks.
   - The content hash covers the proposal id, the detection id and version, the calendar's fixed
     name, and each block's kind, start, end and fixed title ("Interview prep" / "Interview
     warm-up"). It covers no company or interviewer name: event text holds fixed words only (an
     open question below).
   - Paul approves or rejects the whole plan. Nothing edits an approved plan.
   - Slice 1 stores one proposal per detection, so after a rejection nothing can plan that
     interview again until a reschedule makes a new detection version. A second plan for the same
     version needs proposal rounds (a schema change, like `readPackageRounds`), left to a later
     slice.
   - The request is filed through one entry point in `packages/db`. Like `reply_draft` and
     `application_package`, a foreign key pins the stored plan to the request's id, kind and hash,
     so a request someone else files for the same subject can't be written.
4. **The writer acts only on a live approval, at the moment it acts.**
   - It calls `verifyApproval` (`prep_plan`, the subject, the re-computed hash) first, as the Apply
     Gateway and the draft writer do.
   - Inside the undo window the Gate refuses with `UndoWindowOpen` and its `effectiveAt`. The
     writer writes nothing and its own refusal carries `retryAt`, as the mail writer's does.
   - Before writing, it checks that the proposal's detection is still the current version and
     confirmed. A confirmed detection can't be dismissed later (`decideInterview` refuses a second,
     different decision), so only a reschedule replaces it.
     - The writer recomputes the hash over the current detection version. A reschedule changes
       that version, so the hash differs. The writer withdraws the approval (`withdrawApproval` by
       `gateway`, `content_changed`, with the recomputed hash), writes nothing, and leaves a new
       proposal to the next run.
     - The feed line then reads that the approved content changed, which is true of the interview
       time. A withdrawal reason of its own for `prep_plan` would need a migration and a trigger
       change, and is left out.
5. **Writes are safe to repeat (RES-006).**
   - Each block's event gets a client-chosen event id, derived from the Gate decision id and the
     block's index: lowercase base32hex, 5 to 1024 characters, which `events.insert` accepts. A
     repeated insert answers 409, which counts as already written, so a retry never makes a second
     event. A deleted event's id still conflicts, so a block Paul deleted is never re-created by a
     retry.
   - The writer claims each decision in a ledger before calling Google (like `reply_draft_claim`)
     and records the event ids after. Ids and times only, never event text.
   - The Northstar calendar's id belongs to the candidate, not to one decision. It is stored once
     per candidate, in its own append-only row.
   - The "Northstar" calendar is created once, with `calendars.insert`, under a claim with a
     lease (like `DRAFT_CLAIM_LEASE_MS`), so two runs can't each create one. It carries a fixed
     marker in its `description`. After an unknown outcome, the writer looks for that marker in
     the calendar list (`calendarList.list`, a read) before it creates another, never matching on
     the name alone (an open question below).
6. **The only Google writes are `calendars.insert` and `events.insert`** on the Northstar
   calendar, and the only read is that calendar-list lookup. The writer names no update, patch,
   move or delete. A boundary test fails if any URL or client method under `src/calendar/` does.
   Paul removes or moves a block in Google Calendar himself.
   - **Every event is built from hashed fields only.** The body holds exactly `id`, `summary`,
     `start.dateTime` and `end.dateTime`. The times are sent in UTC, so no time zone is needed.
     The writer never sends `attendees`, `conferenceData`, `description`, `location`, `reminders`,
     `visibility` or any `guestsCan*` field. Query parameters are fixed to `sendUpdates=none`, with
     no `conferenceDataVersion`.
     - So an insert can't invite anyone, email anyone or create a meeting link under Paul's name,
       which the approved hash never covered (ADR-0002).
     - Any field added later, such as a reminder on the warm-up, joins the hash first.
     - The boundary test refuses those keys under `src/calendar/`.
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
- + The scope keeps every write off Paul's own calendars and events.
  - On the Northstar calendar, it is the code that limits the writer to inserting approved blocks:
    inserts only, the field allowlist, the request allowlist and the boundary test.
  - The scope alone would let it change or delete any event there, including one someone else adds
    if Paul shares the calendar.
- + A retry, a crash or a double run writes each block once.
- − Blocks on a secondary calendar don't make Paul's primary calendar look busy. People booking him
  through his primary calendar won't see them unless he shares the Northstar calendar's free/busy
  or checks for conflicts himself.
- − Paul runs a command (and consents) to write an approved plan, until #400 decides on a stored
  token.
- − A moved or removed block in Google Calendar isn't noticed by Northstar. The writer only ever
  inserts.
- − After a plan is written, a reschedule leads to a new proposal and new blocks. The old blocks
  stay on the calendar at the old times until Paul deletes them. Removing them automatically would
  need a Gate-approved delete limited to event ids in the ledger: a decision for a later ADR.
- − The reader reads only the primary calendar (ADR-0026), so the planner's busy time won't
  include prep blocks already written to the Northstar calendar. Prep for two interviews close
  together could overlap until the reader also reads that calendar.
- Northstar must keep the boundary tests and the allowlist current whenever the writer changes.
- Open question: Should event titles name the company ("Prep: Initech interview")? That's more useful, but it
  puts a company name in Google's copy of the event. This ADR keeps fixed words. Even so, the
  exact block times reach Google, and the warm-up sits an hour before the interview, so Google's
  copy reveals when the interview is.
- Open question: Does `calendarList.list` accept a `calendar.app.created` token? Google's per-method scope lists
  change over time; Paul should check the current reference. If it doesn't, the ledger's recorded
  calendar id has to be written before any outcome can be unknown.
- Open question: CAL-004's reminders belong on the interview itself, an event this scope can't touch. Should the
  warm-up block carry the hour-before reminder instead, or should reminders stay in Northstar's
  own notifications?
- Open question: Google's consent screen shows `calendar.app.created` as a sensitive scope. Paul should check it
  is offered for this OAuth client before accepting.

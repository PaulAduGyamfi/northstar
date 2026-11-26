# NS-240 slice 2: store detected interviews, and Paul's confirm or dismiss

Status: built (autonomous lane, ADR-0016)
Requirements: CAL-002 · ADR-0026 (Proposed), ADR-0012
Issue #271 (Parent: #121). Slice 1 (#305) added the read-only Calendar client.

## Why
`detectInterview` (packages/inbox) proposes an interview from a calendar event, always
`confirmed: false`: invites aren't authenticated. Nothing stores a detection or lets Paul confirm
it, and NS-241's prep blocks wait for a confirmed interview.

## Behavior
- **`interview_detection`** (append-only, migration + trigger): one row per candidate, calendar
  event id, application and start/end. A rescheduled event is a new row; the newest row for an
  event and application is current. It holds the format (`INTERVIEW_FORMATS`, `packages/domain`),
  the start and end, and the interviewer count. Never a title, description, address or name.
  The application must be the candidate's own (composite foreign key).
- **`recordInterviewDetection`** writes it with an `interview.detected` event on the application's
  aggregate, in one transaction. The feed line is fixed words and the format ("Found a possible
  technical interview on your calendar: confirm it"). The same detection twice stores nothing.
- **`interview_decision`** (append-only): Paul's one `confirmed` or `dismissed` per detection.
  **`decideInterview`** writes it with `interview.confirmed` / `interview.dismissed` (actor
  `user`). A second decision is refused (`AlreadyDecided`); the same decision again stores nothing.
  Deciding never moves the application's status (CAL-002, P1).
- **`listInterviews`** gives the candidate's current detections (superseded ones left out), each
  with its decision or none, by start time.

## Out of scope
- The consent flow (waits for Paul to accept ADR-0026), the caller that runs `listEvents` and
  `detectInterview`, and the API and page for confirming: later slices.

## Acceptance criteria
- [x] A detection is stored once with its feed event; a rescheduled one is a new current row.
- [x] Another candidate's application is refused.
- [x] Confirm and dismiss are recorded once; a different second decision is refused; the
      application's status is unchanged.
- [x] Both tables refuse UPDATE, DELETE and TRUNCATE.
- [x] `pnpm turbo run lint typecheck test build --filter=@northstar/db --filter=@northstar/domain`
      passes.

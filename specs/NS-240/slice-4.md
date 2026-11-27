# NS-240 slice 4: the interview detection run

Status: in progress (autonomous lane, ADR-0016)
Requirements: CAL-002, RES-007, OBS-001 · ADR-0026 (Accepted), ADR-0007 · Issue #271
Slices 1–3: #305 (client), #320 (storage and decision), #338 (consent).

## Why
The client, the detector and the store exist but nothing joins them: no code reads a window of
events, detects interviews and stores them, and the store's `TooManyChanges` / `DailyLimit`
refusals have nowhere visible to go (ADR-0007: never a silent drop).

## Behavior
- `runInterviewDetection(deps)` (a `now` port included) in `packages/inbox` (`interview/run.ts`), plain code:
  - reads one window through `listEvents` (now to now + 30 days; the client caps at 60);
  - runs `detectInterview` on each event against `candidates()` (open applications);
  - for each interview, calls `record` with ids, format, times and the interviewer count only
    (never a title, address or name);
  - a `TooManyChanges` refusal becomes one dead letter per event and application (kind
    `calendar.interview_detection`, reason `too_many_changes`, subject the application);
  - a `DailyLimit` refusal becomes one dead letter per day (reason `daily_limit`, subject the
    candidate) and stops recording for the rest of the run;
  - `InvalidDetection` / `UnknownApplication` count as `skipped` and also get a dead letter each
    (`invalid_detection`, `unknown_application`, per event and application): never a silent drop.
    The interviewer count is capped at the store's 50 rather than refused;
  - the ports use the store's own `Result` shapes (`recordInterviewDetection`, `recordDeadLetter`);
    a letter carries `attempts: 1`, and a thrown or refused letter stops the run
    (`stoppedBy: "dead_letter"`); a thrown record call stops it (`"record"`), a failed read stops it
    before anything (`"read"`).
  - It returns counts only (events, interviews, recorded, unchanged, ambiguous, not interviews,
    no match, too many changes, daily limit, skipped) and sets them on a `calendar.detect` span.
- Dead-letter keys hold a SHA-256 prefix of the event id, never the id itself (ids may carry
  upper case, which the key pattern refuses).
- `packages/db`: `calendar.interview_detection` joins `DEAD_LETTER_KINDS`.
- `apps/web/src/dead-letters.ts`: words for the kind and its two reasons.
- No caller yet (the worker process, #230). No company domains are stored yet (#313), so in
  practice candidates match nothing until that lands.

## Acceptance criteria
- [x] An interview event for one candidate's domain is recorded with ids, format, times and a count.
- [x] Cancelled, non-interview, unmatched and ambiguous events record nothing and are counted.
- [x] `TooManyChanges` writes one dead letter per event and application; a rerun writes none more.
- [x] `DailyLimit` writes one dead letter for the day and stops recording.
- [x] A failed read records nothing and says so.
- [x] `pnpm turbo run lint typecheck test build` passes in the touched packages.

## Out of scope
- The caller and schedule; the API and the confirm page; company domains (#313).

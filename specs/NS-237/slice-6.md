# NS-237 slice 6: the Gmail draft writer's stored ledger

Status: in progress (autonomous lane, ADR-0016)
Requirements: RPL-002, RES-006 · ADR-0025 (item 5), ADR-0012
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`.
Issue #263. Slice 4 (#325) built `writeReplyDraft` against `claimDraft` / `recordDraft` ports.

## Behavior
- **`reply_draft_claim`** (append-only): one row per attempt, per candidate and decision
  (`attempt` 1–100, unique). **`reply_draft_record`** (append-only): at most one per candidate and
  decision, with Gmail's hex message id (CHECK).
- **`claimDraft(db, candidateId, decisionId, now?)`**, in one transaction under a per-decision
  advisory lock:
  - a recorded draft → `done` with its id;
  - no claim → takes attempt 1 → `new`;
  - newest claim younger than `DRAFT_CLAIM_LEASE_MS` (5 minutes, longer than a run's 30 s
    requests) → `in_progress` with the lease's end;
  - otherwise takes the next attempt → `unknown` (the writer looks for a marked draft first).
- **`recordDraft(db, candidateId, decisionId, draftMessageId, now?)`**: inserts the record and a
  `reply.draft_created` event (payload: decision and message ids; fixed-word `reason`) in one
  transaction. The same id again stores nothing; a different id throws `DraftRecordConflict`; a
  non-hex id is refused before insert.
- **`dbMailLedger(db)`** binds both to `MailPorts`.
- No caller yet (the worker, #230).

## Acceptance criteria
- [ ] new / in_progress (with the lease's end) / unknown (taking a fresh claim) / done.
- [ ] Two racing first runs get one claim.
- [ ] One record per decision, its event once, a different second id refused.
- [ ] Updates and deletes refused on both tables; the app role's grants match (`app-role.test.ts`).

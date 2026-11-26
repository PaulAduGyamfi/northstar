# NS-175: Dead-letter for work that exhausts its retries

Status: accepted (autonomous lane, ADR-0016)
Requirements: RES-007 (complements OBS-004) · ADR-0007, ADR-0012
Rules that apply: ADR-0007, ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #87 (NS-147)

## Why
"Fail small" means work that exhausts its retries is never silently dropped: it lands somewhere
Paul can see, and he chooses to retry it, skip it or take it over himself (RES-007). Today there
is no such place.

## Behavior
1. **`dead_letter`** (`packages/db`, append-only): one row per piece of work that gave up: its
   kind (`apply.submit`, `llm.route:<name>` …), the entity it was about (`application:<uuid>`),
   a reason code (`timeout`, `rate_limited` …), how many attempts were made, and an idempotency
   key, so the same failure recorded twice is one letter. Never a payload, message, URL or text.
2. **`dead_letter_resolution`** (append-only, at most one per letter): Paul's (or the system's)
   choice: `retry`, `skip` or `hand_off`, with who and when. A retry that fails again is a new
   letter (with its own key).
3. **Write paths** (`dead-letter-write.ts`, the only writers):
   - `recordDeadLetter(db, input)` → `recorded` or `exists` (same key).
   - `listOpenDeadLetters(db, candidateId, kind?)`: letters with no resolution, oldest first.
   - `resolveDeadLetter(db, { candidateId, deadLetterId, action, actor })` → the letter's kind and
     subject (so the caller can re-run or hand it off), or `NotFound` / `AlreadyResolved`.
   - Each writes one domain event (`dead_letter.recorded`, `dead_letter.resolved`) whose reason is a
     plain sentence (numbers and fixed words) and whose payload holds ids, kind, codes and counts.
4. Inputs are shape-checked in code and by database CHECKs (kind, subject, reason code patterns;
   attempts ≥ 1).

## Acceptance criteria
- [ ] Recording the same key twice stores one letter; a different key stores another.
- [ ] An open letter is listed (oldest first, optionally by kind) until it is resolved.
- [ ] Each action resolves a letter once; a second resolution is `AlreadyResolved`; another
      candidate's letter is `NotFound`.
- [ ] A bad kind, subject or reason code is refused in code and by the database.
- [ ] Both tables refuse UPDATE, DELETE and TRUNCATE.
- [ ] Events carry ids, kind, codes and counts only.

## Failure modes
Two resolutions racing: the unique key on the resolution's letter id lets one win; the other is
`AlreadyResolved`. Database down: the producer's own error handling applies (it keeps its item).

## Observability
`dead_letter.recorded` / `dead_letter.resolved` events (feed shows their reason sentence) and
`dead_letter.record` / `dead_letter.resolve` spans.

## Out of scope (follow-up issue)
- The first producer: no caller has a bounded retry loop yet (board polling has its own quarantine;
  the Apply Gateway turns failures into `needs_human`; the LLM gateway lets Temporal retry).
- The dead-letter view and its retry / skip / hand-off buttons in the app and the API.

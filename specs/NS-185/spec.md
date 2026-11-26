# NS-185: Store the voice profile, Paul's review of it, and his draft edits

Status: accepted (autonomous lane, ADR-0016); the CLI waits for Paul (below)
Requirements: ANS-007, ANS-008
Rules that apply: `.claude/rules/db.md`, `.claude/rules/tests.md`
Parent: #61 (NS-136)

## Why
NS-136 measures Paul's voice from writing samples and learns phrases he keeps deleting, but keeps
nothing: every caller would have to hold the profile and the edit history itself. ANS-007 asks
for a reviewed, stored voice profile; ANS-008 for learning from his edits over time.

## What changes
1. **Storage** (`packages/db`, `voice-schema.ts`, `voice-write.ts`), all append-only (triggers),
   one migration for the tables and one for the triggers:
   - `voice_profile`: one row per version per candidate, with the measured numbers and phrases
     from `measureVoice`. Never a sample's text.
   - `voice_review`: Paul's decision on one version: the phrases he keeps and drops. Every phrase
     of that version must be decided, and nothing else. A later review of the same version
     replaces the earlier one (the newest wins).
   - `voice_edit`: when Paul approves an answer that differs from its draft, only the phrases he
     deleted (`deletedPhrases`), never the draft or the approved text.
   - Write paths: `saveVoiceProfile`, `reviewVoiceProfile`, `readReviewedVoice` (the newest
     version that has a review, with only its kept phrases), `recordVoiceEdit`, `readVoiceEdits`.
   - Events: `voice.measured` (version, sample count, phrase count) and `voice.reviewed`
     (version, kept and dropped counts). No event per edit. Never a phrase or sample text.
2. **Profile** (`packages/profile/src/voice/`):
   - `avoidedFromDeleted(deletedPerDraft, threshold)`: `avoidedPhrases` over stored deleted
     phrases; `avoidedPhrases` becomes a call to it (same results).
   - `store.ts`: `loadVoice(db, candidateId)` gives the guide (`renderVoiceGuide` of the reviewed
     profile, or null) and the avoid list for `draftAnswer`; `recordEdit(db, candidateId, draft,
     approved)` stores the deleted phrases when there are any.
3. **Not in this PR: the CLI** (`profile voice <file> …`, `profile voice review`). It changes
   the CLI's usage line, which `cli.test.ts` asserts exactly: changing that assertion is a stop
   (ADR-0016 item 5), so the PR asks Paul for the go-ahead.

## Acceptance criteria
- [ ] A stored, reviewed profile feeds `renderVoiceGuide`, with only the kept phrases; an
      unreviewed version doesn't.
- [ ] A review must decide exactly the version's phrases.
- [ ] Three stored edits that deleted one phrase make it an avoided phrase (PGlite).
- [ ] The tables refuse updates and deletes; no event carries a phrase or sample text.

## Out of scope
The CLI (above). Feeding `loadVoice` into a drafting caller (none exists yet).

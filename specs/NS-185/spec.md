# NS-185: Store the voice profile, Paul's review of it, and his draft edits

Status: accepted (autonomous lane, ADR-0016); the CLI is a follow-up (#220, NS-222)
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
     deleted (`deletedPhrases`), never the draft or the approved text. One row per approval
     (`subject`, e.g. `answer:<id>`), so a retried approval can't count one draft twice.
   - Phrases are checked before any insert (1–4 words, at most 80 characters; at most 50 per
     version and 200 per edit), so a sentence is never stored and a CHECK never has to quote one.
   - Write paths: `saveVoiceProfile`, `reviewVoiceProfile`, `readReviewedVoice` (the newest
     version that has a review, with only its kept phrases), `recordVoiceEdit`, `readVoiceEdits`.
   - Events: `voice.measured` (version, sample count, phrase count) and `voice.reviewed`
     (version, kept and dropped counts). No event per edit. Never a phrase or sample text.
2. **Profile** (`packages/profile/src/voice/`):
   - `avoidedFromDeleted(deletedPerDraft, threshold)`: `avoidedPhrases` over stored deleted
     phrases; `avoidedPhrases` becomes a call to it (same results).
   - `store.ts`: `loadVoice(db, candidateId)` gives the guide (`renderVoiceGuide` of the reviewed
     profile, or null) and the avoid list for `draftAnswer`; `recordEdit(db, candidateId,
     subject, { draft, approved })` stores the deleted phrases when there are any, once per
     subject.
3. **Not in this PR: the CLI** (`profile voice <file> …`, `profile voice review`). It can follow
   `profile tailor` and `profile settings` (its own sub-usage, no change to the asserted
   top-level line), but it is a separate piece: #220 (NS-222). Until it lands, nothing calls
   `reviewVoiceProfile`.

## Acceptance criteria
- [x] A stored, reviewed profile feeds `renderVoiceGuide`, with only the kept phrases; an
      unreviewed version doesn't.
- [x] A review must decide exactly the version's phrases.
- [x] Three stored edits that deleted one phrase make it an avoided phrase (PGlite); one
      approval recorded three times doesn't.
- [x] The tables refuse updates and deletes; no event carries a phrase or sample text.

## Out of scope
The CLI (above). Feeding `loadVoice` into a drafting caller (none exists yet).

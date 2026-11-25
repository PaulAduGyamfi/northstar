# NS-136: Voice profile from writing samples and learning from edits

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: ANS-007 (a style guide from 5–10 of Paul's writing samples, which he reviews),
ANS-008 (drafts and Paul's approved edits update the voice profile; after he deletes the same
phrase in 3 drafts, the next draft doesn't contain it). GitHub issue #61, parent #17 (NS-118).
Rules that apply: ADR-0004, AGENTS.md (code decides, the model drafts; public repo, synthetic
fixtures only; Paul's samples live in `data/`, never committed), `.claude/rules/tests.md`.

## Why
Answer drafts (NS-135) should sound like Paul, and stop repeating the words he keeps cutting.
Both can be decided by plain code, so the model only drafts.

## Behavior
All in `packages/profile/src/voice/`, plain code, with no model and no database.
1. **Style guide (ANS-007)**, `measureVoice(samples)`. From 5–10 texts it measures:
   - median sentence length in words;
   - how often Paul uses contractions, "I" and "we" (per 100 words);
   - how many sentences end in "!";
   - the phrases (2–4 words) he uses in at least 3 different samples, excluding phrases made
     only of common words.

   It refuses fewer than 5 or more than 10 samples, as ANS-007 asks. `renderVoiceGuide(profile)`
   turns the result into short plain lines ("Sentences: about 14 words."). This text goes into
   the answer-draft route's `voiceGuide` input, which already sits in an untrusted block.
2. **Learning from edits (ANS-008)**:
   - `deletedPhrases(draft, approved)` returns the phrases of 1–4 words that are in the draft and
     not in the approved text. Matching is on lower-cased whole words, longest phrase first, so
     a removed "leverage our synergies" counts once, not also as "leverage".
   - `avoidedPhrases(edits, threshold = 3)` returns every phrase deleted in at least
     `threshold` different drafts, as ANS-008's criterion says. Phrases made only of common words
     are never banned, so removing "and the" doesn't ban it.
   - `findAvoided(text, phrases)` returns the banned phrases a text contains, as whole words.
3. **Drafting uses both** (`draftAnswer`, NS-135):
   - The request takes an optional `avoid` list. It is appended to the voice guide ("Avoid:
     …") so the model is told.
   - A draft that still contains a banned phrase is never returned: it becomes `needs_human`
     with reason `voice` and the banned phrases' positions in the list, never the text.
4. **CLI for Paul:** `profile voice <file> <file> …` reads 5–10 samples with `fileToText` and
   prints the guide. Paul only (it prints his own phrases); agents never run it. Nothing is
   stored.

## Acceptance criteria
- [ ] `measureVoice` on synthetic samples gives the expected numbers and repeated phrases,
      refuses 4 or 11 samples, and skips phrases made only of common words (profile tests).
- [ ] After the same phrase is deleted in 3 drafts, `avoidedPhrases` returns it. With 2 drafts it
      doesn't, and deleting it 3 times in one draft counts once (ANS-008's criterion).
- [ ] `draftAnswer` returns `needs_human` (`voice`) for a draft containing an avoided phrase, and
      passes the guide and the avoid list to the route (profile tests).
- [ ] `profile voice` prints the guide for 5 synthetic files, and refuses 4 (cli test).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Too few or too many samples:** refused with a plain message; nothing is guessed.
- **An unreadable sample:** `fileToText` names the file only.
- No new I/O beyond reading Paul's files, so no dependency can be down.

## Observability
None new: nothing is stored or sent. The draft's `needs_human` reason carries the voice failure.

## Out of scope
- **Storing the voice profile and Paul's review of it,** and recording each draft/approved pair
  as he edits. That needs a table, and another agent is changing `packages/db` migrations, so it
  is a follow-up issue. Until then the callers keep the edit history.
- A model-written style summary. The measured guide is enough for drafting; a model route would
  need its own eval and real samples, which are Paul's.
- ANS-009 (a self-critique pass).

## Open questions
- The thresholds (3 samples for a phrase Paul uses, 3 drafts for a phrase he avoids) follow
  ANS-008's criterion. Paul can tune them once there is real data.

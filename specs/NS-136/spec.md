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

   It refuses fewer than 5 or more than 10 samples, as ANS-007 asks, and any sample over 5,000
   words. `renderVoiceGuide(profile)` turns the result into short plain lines ("Sentences: about
   14 words."). This text goes into the answer-draft route's `voiceGuide` input, which already
   sits in an untrusted block.
   - Words are compared after NFKC normalisation, with hidden format characters dropped and every
     apostrophe made straight, so look-alike spellings count as the same word.
   - "'s" doesn't count as a contraction: it is as often a possessive.
2. **Learning from edits (ANS-008)**:
   - `deletedPhrases(draft, approved)` returns the phrases of 1–4 words that are in the draft and
     not in the approved text. Matching is on lower-cased whole words, longest phrase first, so
     a removed "leverage our synergies" counts once, not also as "leverage".
   - `avoidedPhrases(edits, threshold = 3)` returns every phrase deleted in at least
     `threshold` different drafts, as ANS-008's criterion says.
     - Every part of a deleted phrase counts, so "leverage" cut from three different phrases
       ("leverage our tooling", "leverage the data", "leverage") is avoided, as ANS-008's own
       example asks.
     - A part inside a longer phrase deleted as often is reported once, as the longer phrase.
     - Phrases made only of common words are never avoided, so removing "and the" doesn't ban it.
     - Edits over 2,000 words on either side are skipped, because the word diff is quadratic.
   - `findAvoided(text, phrases)` returns the banned phrases a text contains, as whole words.
3. **Drafting uses both** (`draftAnswer`, NS-135):
   - The request takes an optional `avoid` list. Reduced to the plain words the check uses, it is
     appended to the voice guide ("Avoid: …") so the model is told. `draftAnswer` is the only
     place that adds this line.
   - A draft that still contains a banned phrase is never returned: it becomes `needs_human`
     with reason `voice` and the banned phrases' positions in the list, never the text.

## Acceptance criteria
- [ ] `measureVoice` on synthetic samples gives the expected numbers and repeated phrases,
      refuses 4 or 11 samples, and skips phrases made only of common words (profile tests).
- [ ] After the same phrase is deleted in 3 drafts, `avoidedPhrases` returns it. With 2 drafts it
      doesn't, and deleting it 3 times in one draft counts once (ANS-008's criterion).
- [ ] `draftAnswer` returns `needs_human` (`voice`) for a draft containing an avoided phrase, and
      passes the guide and the avoid list to the route (profile tests).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **Too few or too many samples:** refused with a plain message; nothing is guessed.
- **A sample over 5,000 words, or an edit over 2,000:** refused or skipped, so measuring and
  diffing stay quick.
- No new I/O beyond reading Paul's files, so no dependency can be down.

## Observability
None new: nothing is stored or sent. The draft's `needs_human` reason carries the voice failure.

## Out of scope
- **Storing the voice profile and Paul's review of it, and recording each draft/approved pair
  as he edits.** That needs a table, and another agent is changing `packages/db` migrations, so
  it is a follow-up issue. Until then the callers keep the edit history.
- **A `profile voice` command** to read Paul's samples and print the guide. It would change the
  CLI's usage line, which an existing test asserts exactly, and changing an assertion is a stop
  under ADR-0016 item 5. It goes with the storage follow-up.
- Avoided phrases in `followUps`: only the answer's sentences are checked, which is what ANS-008
  asks ("the next draft does not contain it").
- A model-written style summary. The measured guide is enough for drafting; a model route would
  need its own eval and real samples, which are Paul's.
- ANS-009 (a self-critique pass).

## Open questions
- The thresholds (3 samples for a phrase Paul uses, 3 drafts for a phrase he avoids) follow
  ANS-008's criterion. Paul can tune them once there is real data.

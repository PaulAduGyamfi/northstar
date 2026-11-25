# NS-202: Name checks for mixed-case names, joined tokens and story titles

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: CPG-003 (stories are Paul's words), ANS-004 (answers cite evidence), ADR-0004 (no
fabrication). GitHub issue #177 (agent-filed; chain #174 → #141 → #10).
Rules that apply: AGENTS.md (code decides; never loosen a check), `.claude/rules/tests.md`.

## Why
The story and answer name checks only look at words that start with a capital letter. A name
the model invents can slip past in several ways:
- a mixed-case tool such as "iOS" or "eBay";
- a name joined to another word, such as "ex-Globex" or "planner/Globex";
- a name that starts with a digit, such as "3M".

Story titles are never name-checked. But the title is part of a story's answer evidence, so a
name invented in a title could back a name in a later answer.

## Behavior
1. **`nameParts(word)`** (`packages/profile/src/names.ts`, plain code).
   - The word, with its edge punctuation and possessive already removed, is split on `-` and
     `/`.
   - Each piece is a name candidate when it:
     - starts with a capital ("Globex");
     - has a capital right after a lower-case letter ("iOS", "eBay"); or
     - starts with a digit and holds a capital ("3M", "5G").
   - "I" and its contractions are never names.
   - The story check (`unbackedNames`) and the answer check (`validateAnswerDraft`) both use it.
     Every candidate must be backed exactly as a capitalised word is today: as a whole word,
     case-sensitive.
   - The sentence-opener exemption applies only to the first piece of a sentence's first word.
2. **Story titles are out of the evidence a sentence can lean on.**
   - `EvidenceItem` gets an optional `checkText`. `storyEvidence` sets it to the four parts only,
     without the title.
   - `validateAnswerDraft` reads quotes and names from `checkText` when it is set, otherwise from
     `text`.
   - The route still shows the model the title, so request keys and recorded fixtures don't
     change.
   - Titles are never name-checked, so an invented name there can't become evidence. A quote
     taken from a title is refused (fail safe).
3. **Titles still have no number-word rule.**
   - NS-200 found that a recorded fixture's title ("…, twice") fairly sums up "rolled it out
     again".
   - With titles out of the answer evidence, a number word in a title can't back an answer
     either.

## Acceptance criteria
- [ ] A story part or answer sentence naming an unbacked "iOS", "eBay", "ex-Globex",
      "planner/Globex" or "3M" is refused. The same words backed by the sources pass (profile
      tests).
- [ ] An answer naming a word found only in a story's title is refused. One quoting the title is
      refused too. The same name or quote from a story part passes.
- [ ] The rendered answer-draft request is unchanged (the existing route tests and the eval
      replay).
- [ ] `eval --all` (CI): `story-draft` and `answer-draft` at or above baseline. A fixture that
      starts failing is a finding for Paul, never a reason to loosen.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope (recorded as a decision)
- **All-lowercase names** ("at globex", "kubernetes", "npm"). Plain code can't tell them from
  ordinary words without a vocabulary of known names, and a dictionary would refuse ordinary
  words. They stay unchecked; the issue's notes say so.
- **Case-insensitive name matching** stays off. The issue keeps it strict unless Paul decides
  otherwise.
- **The same name rule in `checkThesis` and the resume-tailor free-text check.** The issue names
  only the story and answer checks.

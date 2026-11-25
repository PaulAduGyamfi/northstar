# NS-200: Whole-number quotes in the answer check, and names in story text

Issue: #174 (its title says NS-198; #170 took that number first, see the issue's comment)
Status: accepted (autonomous lane, ADR-0016)
Requirements: ANS-004, CPG-003
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/llm.md`, `.claude/rules/tests.md`
Parent: #141 (NS-184)

## Why
NS-184 made story quotes whole words and whole numbers with a story-local `quotedIn`. The
answer check still uses `hasWhole`, which treats "." "," and "-" as boundaries, so "5 million"
passes inside "1.5 million" and backs an invented "5". And a story's text may name an employer,
tool or person that none of Paul's answers or the resume line mention: only numbers are checked.

## Behavior
1. `quotedIn` moves next to `hasWhole` (`packages/profile/src/validate.ts`) and also refuses a
   quote that stops or starts inside a negation ("I can" or "t fix" out of "I can't fix"); a
   possessive may follow a quote ("Example Freight" out of "Example Freight's"). Stories and answers both
   match quotes with it. `hasWhole` is unchanged for its other callers (resume provenance,
   thesis, tailoring).
2. Story parts' text: every capitalised word except "I" (and "I'm", "I've") must appear as a
   whole word in Paul's answers or the resume line (case-sensitive; a possessive "'s" is
   dropped). A sentence's first word is exempt when it is an ordinary opener (`STARTERS`) or the
   part's own quotes hold it in lower case, so an employer that is a common word ("Target") can't
   pass as an opener. A failure names the part and the word's position, never the word.
3. Story parts' number words ("twenty", "double", "half") must be in their own quotes or the
   resume line. Titles keep the digit rule only: no name rule (they may be title case) and no
   number-word rule (a title summarises: "…, twice" for "rolled it out again"; the recorded
   `failure-and-learning` fixture does exactly that). Both are #177.

## Acceptance criteria
- [ ] An answer quote cut from inside "1.5 million", "1,200" or "-5%" is refused.
- [ ] A story or answer quote ending inside "can't" is refused.
- [ ] A story part naming a company or tool that no answer or the atom mentions is refused; one
      whose names all come from the answers or atom passes; sentence openers pass.
- [ ] `eval --all` (CI) replays `answer-draft` and `story-draft` at or above baseline. A fixture
      that starts failing is a finding for Paul (`needs:paul`), never a reason to loosen.

## Failure modes
None new: plain code over strings. A stricter check refuses more drafts; the interview and the
answer drafter already handle a refused draft.

## Observability
Unchanged: failures carry part or sentence, and positions, never text.

## Out of scope
- Letting only passing quotes back a part's numbers (#174 item 3): it changes the exact failure
  lists two existing tests assert, so it needs Paul (filed as `needs:paul`).

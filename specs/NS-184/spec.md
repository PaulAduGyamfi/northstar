# NS-184: Story provenance check matches quotes as whole words

Status: accepted (autonomous lane, ADR-0016)
Requirements: CPG-003
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/llm.md`, `.claude/rules/tests.md`
Parent: #10 (NS-111)

## Why
`validateStoryDraft` accepts a quote when it is a substring of one of Paul's answers. A quote cut
from inside a longer number ("2 engineers" out of "we were 12 engineers") therefore counts as
verbatim, and the part's number rule then lets the story say "2 engineers". NS-135 fixed the same
pattern in `validateAnswerDraft`.

## Behavior
1. A story quote must appear in one answer as whole words (`hasWhole`, `packages/profile/src/validate.ts`):
   it may not start or end inside a longer word or number.
2. A story quote must be at least two words (`MIN_QUOTE_WORDS`, as in the answer validator), so a
   single word can't make a part "quoted".
3. Failures keep naming the part and the problem, never the text.

## Acceptance criteria
- [ ] "2 engineers" quoted from "we were 12 engineers" fails, and so does the part's "2".
- [ ] A one-word quote fails with "shorter than 2 words".
- [ ] A whole-word quote of two or more words still passes.
- [ ] `eval --all` (CI) replays `story-draft` at or above its baseline. If a recorded fixture now
      fails, that is a finding for Paul (a `needs:paul` issue), never a reason to loosen the check.

## Failure modes
None new: plain code over strings. A story the stricter check refuses is not saved, as today.

## Observability
Unchanged: a refused draft is recorded by the interview as before, with problem codes only.

## Out of scope
Other validators (they already match whole words).

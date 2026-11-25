# NS-184: Story provenance check matches quotes as whole words

Status: accepted (autonomous lane, ADR-0016)
Requirements: CPG-003
Rules that apply: ADR-0004, ADR-0016, `.claude/rules/llm.md`, `.claude/rules/tests.md`
Parent: #10 (NS-111)

## Why
`validateStoryDraft` accepts a quote when it is a substring of one of Paul's answers. A quote cut
from inside a longer number ("2% to 3%" out of "12% to 3%", or "5% to 3%" out of "12.5% to 3%")
therefore counts as verbatim, and the part's number rule then lets the story say "2%". NS-135
fixed the same pattern in `validateAnswerDraft`.

## Behavior
1. A story quote must appear in one answer as whole words and whole numbers (`quotedIn`, local to
   `story-validate.ts`): it may not start or end inside a word, inside a number written with a
   decimal point or thousands separator, or just after a minus sign. A draft with a rejected
   quote is rejected whole, so the number that quote carried is never saved.
2. A story quote must be at least two words (`MIN_QUOTE_WORDS`, as in the answer validator), so a
   single word can't make a part "quoted".
3. Failures keep naming the part and the problem, never the text.

## Acceptance criteria
- [ ] "2% to 3%" quoted from "12% to 3%" fails (so the draft is refused); the same for
      "5% to 3%" out of "12.5% to 3%", "200 users" out of "1,200 users" and "5%" out of "-5%".
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

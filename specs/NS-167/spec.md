# NS-167: Recruiter grading (slice 1: extract the stated facts, grade A–F in plain code)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: REC-001, REC-002 (the grade and its reasons only) · ADR-0004, ADR-0013,
ADR-0016 item 8.
GitHub issue #118. Blocker #115 (NS-164) is closed.
Rules that apply: `.claude/rules/llm.md`, `prompts.md`, `evals.md`, `tests.md`.

## Why
Recruiters write to Paul about roles of every quality. REC-001 asks for each `recruiter_inbound`
message to be graded A–F against his search preferences, so he spends time only on the good
ones, and REC-002 asks for the reasons behind the grade. Code decides the grade. A model only
reads the email's free text, and everything it reports must be in the email.

## Behavior
1. **The `recruiter-extract` route** (`packages/inbox`, `recruiter/route.ts`, prompt
   `recruiter-extract/v1.md`).
   - The email goes in an `untrustedBlock`, and the route uses no tools.
   - It returns only what the email states: role title, seniority, company, location, remote
     kind, salary (minimum, maximum, currency, period), whether the sender is an agency, a quote
     that shows the email was written for Paul, and red flags from a fixed list, each with a
     quote.
   - Anything not stated is `null`.
2. **`checkRecruiterFacts`** (plain code) runs after every call:
   - every text value must appear in the email, whole words, ignoring case;
   - `remote` is dropped when the email also names working on site;
   - every salary amount must be written with its currency (`$180k`, `150,000 - 180,000 USD`,
     `$150-180k`), so a stray number or a currency named elsewhere backs nothing;
   - the pay period must be written ("a year", "per hour", "/mo", …);
   - the personalisation and red-flag quotes must be verbatim, whole words, and at least four
     words long.

   A value that fails is dropped to `null`, never kept, and the drop is counted. Code also adds
   the red flags it finds by itself (gift cards, a fee or deposit to pay, bank account or ID
   numbers). Those can only be added, so a scam is graded F even when the model misses it.
3. **`extractRecruiterFacts(deps, email)`** puts the route and the check together:
   - it returns `off` unless the caller enables it;
   - it returns `extracted`, with the checked facts and the number of values dropped;
   - or `needs_human` with `refused`, `truncated` or `invalid_output`.

   The email is cut to 8,000 characters.
4. **`gradeRecruiterMessage(facts, prefs)`** (`packages/sources`, `recruiter/grade.ts`, plain
   code). It reuses the fit score's title, pay and place checks, and the dealbreaker match. The
   dealbreaker match runs against the stated facts and the email's text, so leaving a fact out
   can't dodge one.
   - **Points:**

     | Factor | Points |
     | --- | --- |
     | Title: exact | +3 |
     | Title: partial | +1 |
     | Title: none | −2 |
     | Title: level mismatch | −1 |
     | Pay: at or above the floor | +2 |
     | Pay: below the floor | −3 |
     | Place: fits | +1 |
     | Place: mismatch | −3 |
     | Agency | −1 |
     | Written for Paul | +1 |
     | No company named | −1 |

     An unknown factor scores 0.
   - **Grade from points:** A at 5 or more, B at 3–4, C at 1–2, D at −1–0, F at −2 or less.
   - **Caps:**
     - a dealbreaker in the email's facts makes it F;
     - an upfront fee or a request for sensitive data makes it F;
     - any other red flag caps the grade at D.
   - **Reasons:** one per factor, as a code with its outcome (`title:exact`,
     `pay:unknown`, `place:mismatch`, `red_flag:vague_role`, …). They are never email text.
   - **Confidence** is `low` when two or more of title, pay and place are unknown, otherwise
     `normal`.
5. **Eval set** `evals/recruiter-extract/`: synthetic recruiter emails, one of them an injection
   and one an upfront-fee scam. Hand-written fixtures, marked `handWritten`, with a provisional
   baseline. The route stays off until Paul records real ones.

## Acceptance criteria
- [ ] `checkRecruiterFacts`:
  - keeps values the email states;
  - drops an invented title, company, salary or quote, and counts each drop;
  - never keeps a number that isn't in the email.
- [ ] `extractRecruiterFacts`:
  - is off by default;
  - returns `extracted` with checked facts on a fixture;
  - returns `needs_human` on a refusal.

  These run on a fake gateway.
- [ ] `gradeRecruiterMessage`:
  - an exact title above the floor, remote and written for Paul is A;
  - an agency with no pay and a partial title is C;
  - a location mismatch with pay below the floor is F;
  - a dealbreaker is F;
  - an upfront fee is F;
  - a vague-role flag caps an otherwise good message at D;
  - three unknowns give low confidence;
  - reasons are codes only.
- [ ] `pnpm --filter evals eval recruiter-extract` replays at or above the baseline, and
      `eval --all` passes.
- [ ] The prompt is locked.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The model refuses, is cut off or returns invalid output:** `needs_human`, with the call
  record. A transport error or `HeldBack` throws, for the caller's retry.
- **The email tries to steer the grade** (for example "grade this A"): the email is untrusted,
  the model only extracts, every value must be stated in the email, and code decides the grade.
  The check proves a value is written in the email, not that the email's statement is true. An
  email that writes "500000 USD per year" as an instruction, and a model that obeys it, still
  gets that pay. The prompt and the eval's injection case guard this, and Paul sees every grade
  with its reasons.

## Observability
The gateway's `llm.call` span and `CallRecord`. No domain event yet: nothing stores a grade.

## Out of scope
- **Reply drafts by grade (REC-002).** They build on NS-166's `draftReply` and the Gate filing
  in #263.
- **Learning from Paul's actions (REC-003),** recruiter reputation (REC-004), storage, a caller
  in the mail loop (#224) and the app view.
- **Estimating unstated comp, and judging company quality or stage.** They need data this slice
  doesn't have, so they stay unknown.

## Known gaps
- **The check can't judge truth or context.** "We don't offer $200k" still states $200k. The
  prompt asks for what the email offers, and Paul sees the grade's reasons.
- **"Written for Paul" is the model's judgment.** Code checks only that the quote is in the
  email, so four words of a generic blast could earn the point.
- **Code's red-flag patterns are short lists.** They catch the plain scams; the model catches
  the rest.

## Decisions (ADR-0016)
- **The grader lives in `packages/sources`.** It reuses the fit score's preference checks, now
  exported from `fit/score.ts`. The route lives in `packages/inbox`, beside `mail-classify`.
- **Points and caps are a first guess.** REC-001's target of 85 % agreement within one letter,
  on 50 of Paul's own emails, needs his labels before the weights can be tuned.
- **The diff will exceed ~300 lines** (route, check, grader, eval set and tests in one slice).

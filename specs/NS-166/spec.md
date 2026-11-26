# NS-166: Reply drafts (slice 1: which mail needs a reply, and a checked reply draft)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: RPL-001, RPL-002 (the decision only) · ADR-0002, ADR-0004, ADR-0013, ADR-0014,
ADR-0016 item 8.
GitHub issue #117. Blocker #115 (NS-164) is closed. The scope decision is the comment on #117 of
2026-11-26.
Rules that apply: `.claude/rules/llm.md`, `prompts.md`, `evals.md`, `tests.md`.

## Why
Some job mail needs an answer from Paul: a recruiter's question, an assessment invite, an
interview request. RPL-001 asks for a reply drafted in his voice, and ADR-0004 requires every
claim about him to cite his own stories or resume lines. This slice decides which mail needs a
reply and drafts one that plain code has checked. It doesn't store or send anything, and it writes
nothing to Gmail.

## Behavior
1. **`replyNeed(kind)`** (`packages/domain`, `reply-need.ts`, plain code). It maps a
   classification to a reply:
   - `reply` for `recruiter_inbound`, `assessment` and `follow_up_needed`;
   - `reply_without_times` for `interview_request` and `scheduling`. Real free slots need
     Calendar (RPL-003, NS-169), so until then the draft may propose no times;
   - `none` for `confirmation`, `rejection`, `offer` (Paul answers an offer himself),
     `info_other` and any unknown kind.
2. **The `reply-draft` route** (`packages/profile`, `reply/route.ts`). Its inputs are four
   untrusted blocks: the email's text, Paul's voice guide, his evidence (approved stories and
   atoms, chosen by `selectEvidence` over the email's words) and whether times are allowed. It
   uses no tools, and its prompt is `packages/prompts/prompts/reply-draft/v1.md`. Each sentence
   of the output is one of two kinds:
   - a **claim**, which cites evidence items with verbatim quotes;
   - **framing** ("Thanks for reaching out."), which cites nothing.
3. **`validateReplyDraft`** (`reply/validate.ts`, plain code, no model):
   - Claims are checked by the answer-draft rules (`validateAnswerDraft`): verbatim whole-word
     quotes of at least two words, numbers from the sentence's own quotes, and names from the
     items it cites.
   - Framing carries no digits, number words or times. Its capitalised words must be sentence
     openers, greeting or sign-off words, or names found whole in the email itself (the
     recruiter's or the company's name). It is at most 25 words a sentence and 3 sentences a
     draft. So framing can greet and thank, but it can't claim a fact about Paul.
   - A draft needs at least one sentence. Failures name the sentence and the problem, never the
     text.
4. **`draftReply(deps, request)`** (`reply/draft.ts`). It mirrors `draftAnswer`:
   - It returns `off` unless the caller enables it.
   - It returns `none` when `replyNeed` says no reply is needed.
   - Otherwise the route runs, and the validator decides between `drafted` and `needs_human`,
     with the reason `refused`, `truncated`, `invalid_output`, `provenance` or `voice`.
   - Phrases Paul has deleted three times are avoided, as in `draftAnswer` (ANS-008).
   - When no evidence matches, the route still runs, since a framing-only reply is allowed (for
     example, to accept an assessment invite).
5. **Eval set** `evals/reply-draft/`: synthetic cases with hand-written fixtures marked
   `handWritten` and a provisional baseline. The route stays off until Paul records real fixtures
   (ADR-0016 item 8).
6. **ADR-0025 (Proposed): Gmail drafts with `gmail.compose`.** Per the decision on #117:
   - Gmail drafts use `gmail.compose`, with the same token model as ADR-0014;
   - a draft is created only for a reply Paul approved in the Gate;
   - Northstar never sends. Because `gmail.compose` can send, a boundary test will allow only
     the drafts-create call;
   - Paul adds the scope to his OAuth client himself.

## Acceptance criteria
- [ ] `replyNeed` maps all nine kinds as above, and an unknown kind to `none` (unit tests).
- [ ] The validator:
  - passes a draft whose claims are cited and whose framing is plain;
  - fails a claim with an invented number or name;
  - fails framing that holds a number, a time or a name that isn't in the email;
  - fails a fourth framing sentence;
  - fails a framing sentence over 25 words;
  - names failures without text.
- [ ] `draftReply`:
  - is off by default;
  - returns `none` for a rejection without calling the gateway;
  - returns `drafted` on a valid fixture;
  - returns `needs_human` (`provenance`) on an invented claim;
  - returns `needs_human` (`voice`) on an avoided phrase.
  These run on a fake gateway.
- [ ] `pnpm --filter evals eval reply-draft` replays the hand-written fixtures at or above the
      baseline, and `eval --all` still passes.
- [ ] The prompt is locked in `prompts.lock.json`.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Failure modes
- **The model refuses, is truncated or returns invalid output:** `needs_human` with that reason
  and the call record. A transport error or `HeldBack` throws, for the caller's retry.
- **The email tries to instruct the model:** it is an untrusted block, the route has no tools,
  and the validator rejects any claim not cited from Paul's evidence. Framing can't carry
  numbers, times or names from outside the email.

## Observability
The gateway's `llm.call` span and `CallRecord`. There is no domain event yet: no caller stores a
draft (a later slice files it with the Gate).

## Out of scope
- **Gmail drafts.** The gateway call, the scope and the boundary test come with the caller, after
  Paul adds the scope.
- Filing the draft with the Gate, storing it, a caller in the mail loop (#224) and the app view.
- **Scheduling slots (RPL-003).** They wait for NS-169.
- **Follow-up nudges after silence (RPL-004).** They come in the next slice.
- Thank-you notes (RPL-005).

## Decisions (ADR-0016)
- **Placement in `packages/profile`.** The draft rests on Paul's stories and atoms, and the
  answer-draft checks live there. `packages/inbox` isn't a dependency of it.
- **Framing sentences** are allowed, unlike in answers, because a reply needs a greeting. They
  are bounded by the plain-code rules above.

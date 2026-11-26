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
2. **The `reply-draft` route** (`packages/profile`, `reply/route.ts`). Its inputs are five
   untrusted blocks:
   - the email's text;
   - the sender's first name;
   - Paul's voice guide;
   - his evidence: approved stories and atoms, chosen by `selectEvidence` over the email's words;
   - whether times are allowed.

   It uses no tools. Its prompt is `packages/prompts/prompts/reply-draft/v3.md`, which lists the
   framing sentences, and a test checks that the list matches the code's. `v1` (a blocklist) and
   `v2` (a word list) were replaced before they shipped, after the security reviews. They stay
   locked, because committed versions are never edited, and are never loaded. Each sentence
   of the output is one of two kinds:
   - a **claim**, which cites evidence items with verbatim quotes;
   - **framing** ("Thanks for reaching out."), which cites nothing.
3. **`validateReplyDraft`** (`reply/validate.ts`, plain code, no model):
   - Claims are checked by the answer-draft rules (`validateAnswerDraft`): verbatim whole-word
     quotes of at least two words, numbers from the sentence's own quotes, and names from the
     items it cites.
   - A claim may not add, outside its own quotes:
     - a commitment word, matched by its start so inflections and joins count (accept, decline,
       agree, sign, relocate, salary, pay, paid, sponsor, visa, clearance, offer, contract,
       notice, withdraw, available, start, consent, join, resign, begin, immediate, onsite,
       remote, and yes, no, ok, okay, sure, deal, confirm);
     - a time word;
     - a link or address;
     - a symbol;
     - a letter outside the Latin script.
   - No sentence may hold an invisible character.
   - **Framing is a fixed set of whole sentences** (`framingSentences`):
     - a greeting (`Hi {name},`, `Hi,` …);
     - a thank-you;
     - a greeting with a thank-you;
     - a next step or sign-off (`I'll send my availability shortly.`, `I'll get back to you
       soon.`, `I'd be glad to talk more.`, `Thanks again.`, `Best regards,`).

     `{name}` is the sender's first name, which code parses from the From header
     (`greetingName`). It must be one capitalised word of letters only, and never a word that
     answers or commits ("Yes", "Accept"), because the sender chooses it. There are at most 3
     framing sentences. So framing can't state a fact, figure, time, name or link, and can't say
     yes, whatever the email says.
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
  - passes a draft whose claims are cited and whose framing is allowed;
  - fails a claim with an invented number, name, commitment word, time, link, symbol or
    lookalike letter, and any sentence with an invisible character;
  - fails framing that isn't an allowed sentence, including allowed words that say yes;
  - fails a greeting with a sender name that answers or commits;
  - fails a fourth framing sentence;
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
- **The email tries to instruct the model:** it is an untrusted block, and the route has no
  tools. The validator rejects:
  - any claim not cited from Paul's evidence;
  - any claim that adds a commitment word;
  - any framing sentence outside the fixed set.

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
- **RPL-001's application context and answer bank.** The draft uses only Paul's stories, his atoms
  and his voice for now.

## Known gaps
- **`I'd be glad to talk more.` can still sound willing**, for example in reply to "can you start
  Monday?". It names no date, term or fact, and Paul approves every draft.
- **Claims can add lowercase words their quotes lack** that aren't on the lists, such as a
  synonym like "come aboard". The lists catch the plain terms, and Paul approves every draft.
- **The email's wording chooses which evidence the drafter sees** (`selectEvidence`). The
  approval view (RPL-002) should say which stories a draft uses.
- **`followUps` are model text shaped by the email.** They are shown to Paul only, as questions
  from the drafter, never as instructions.

## Decisions (ADR-0016)
- **Placement in `packages/profile`.** The draft rests on Paul's stories and atoms, and the
  answer-draft checks live there. `packages/inbox` isn't a dependency of it.
- **Framing sentences** are allowed, unlike in answers, because a reply needs a greeting. They
  are a fixed set of whole sentences, after two security reviews showed that a blocklist and
  then a word list let an email make framing say yes.
- **Prompt versions 1 and 2 stay in the lock, unused.** Committed prompt versions are never
  edited, so the fixes went into `v3`.

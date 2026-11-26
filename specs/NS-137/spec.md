# NS-137: Model confirm step for canonical-question matching

Status: built
Requirements: ANS-002 (and ANS-001 for the kinds)
Rules that apply: ADR-0004, ADR-0006, ADR-0016 (item 8: hand-written fixtures), ADR-0021 (spend
cap priority), `.claude/rules/llm.md`, `.claude/rules/tests.md`. Decision on #62 (Paul's
delegation, 2026-11-26): no embedding provider; keep the lexical matcher and add a model confirm
step on the existing gateway, only for low-confidence or ambiguous matches.

## Why
`matchQuestion` (NS-118) is plain lexical matching. A narrative question worded unlike any catalog
wording ("Walk us through a stretch where the requirements kept shifting") scores under 0.6 and is
treated as new, so a banked answer Paul already approved is not reused. Two close narrative
questions can also tie and come out "ambiguous". A model that only picks among the catalog
questions code already found close, or says none, recovers those reuses without letting the model
decide anything code can.

## Behavior
- `rankCanonical(question)` (`question-match.ts`): every canonical question with its best lexical
  score, highest first. `matchQuestion` uses it and behaves exactly as before.
- `confirmCandidates(question)` (`question-confirm.ts`): the canonical questions the model may
  choose from: narrative or company-specific only (never factual: a factual match fills an answer
  from settings without drafting, so it stays with code's stricter 0.75 threshold), lexical score
  at least `CONFIRM_FLOOR` (0.4), at most `MAX_CONFIRM_CANDIDATES` (3), best first.
- The `question-confirm` route: the form question as an untrusted block, the candidates (catalog
  text, trusted) with their index. Output `{ choice: int | null }`: an index, never text. Effort
  low, 300 tokens, 30 s, priority `normal`.
- `confirmQuestion({ gateway, enabled }, question)` returns `{ match, by }`:
  - A lexical match, an empty question or a negated factual one is returned as is (`by: "rules"`),
    with no call.
  - Only `new` with reason `below_threshold` or `ambiguous` and at least one candidate calls the
    route, and only when `enabled` is true (off by default: the fixtures are hand-written).
  - A negated question (`NEGATION`, as in package assembly) is returned as is.
  - A question whose nearest canonical question is factual is returned as is: it is never offered
    narrative stand-ins ("Are you authorized to work here and do you need sponsorship?").
  - A choice that is an index into the candidates becomes
    `{ status: "matched", canonical, confidence, confirmedBy: "model" }` (the lexical score)
    with `by: "model"`. A caller must never count such a match as reuse for the Gate's policy
    (`bank_exact` or `bank_high_confidence`): an injected or mistaken pick must reach Paul. Null,
    an index out of range, a refusal, a truncated or invalid output leaves the lexical result
    (`by: "rules"`). A transport error or `HeldBack` throws, so the caller retries.
- An eval set `evals/question-confirm/` (synthetic questions, one injection case, one "none"
  case), hand-written fixtures and a provisional baseline.

## Acceptance criteria
- [x] `matchQuestion`'s existing tests pass unchanged.
- [x] Tests: off by default makes no call; a lexical match makes no call; factual-only
      candidates make no call; a question nearest a factual one makes no call; a valid choice matches by model; null, out of range and a refusal
      keep the rules result; a transport error throws; the question goes in an untrusted block.
- [ ] `eval --all` in CI replays `question-confirm` at or above its baseline.
- [x] The prompt is locked in `prompts.lock.json`.

## Failure modes
- Anthropic slow or down: the gateway's timeout and breaker; `HeldBack`/transport errors throw to
  the caller, which retries. Nothing is decided on a failed call.
- Garbage output: schema check (`InvalidOutput`) or an out-of-range index keeps the lexical "new",
  so the question is drafted fresh: the safe side.
- A wrong choice: a banked answer for the wrong question would be reused. Bounded because the
  choice is limited to close narrative candidates, and every reused answer still goes through the
  Gate (ANS-005, APPLY-004).

## Observability
The gateway's `llm.call` span and call record. No domain event: nothing stores or acts on the
result yet (no caller).

## Out of scope
- An embedding provider (decided against on #62).
- The private labelled set of real questions and threshold tuning (Paul's hands, `evals/**/private/`).
- Recording real fixtures and the real baseline (Paul, `eval question-confirm --record`).
- A caller: package assembly (`packages/pipeline`) still uses lexical matching until this is on.

## Open questions
- `CONFIRM_FLOOR` 0.4 and 3 candidates are guesses, to tune with Paul's private set.

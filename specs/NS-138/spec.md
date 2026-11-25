# NS-138: Model-assisted requirement matching for the Fit Score

Status: accepted (autonomous lane, ADR-0016)
Requirements: MAT-001, MAT-002
Rules that apply: ADR-0004, ADR-0013, ADR-0016 (item 8), `.claude/rules/llm.md`, `.claude/rules/db.md`
Parent: #15 (NS-116)

## Why
NS-116 matches a requirement to an experience atom only when the requirement names a technology
the atom names. Requirements about years, domains or soft skills ("5+ years building APIs",
"strong written communication") are always unmatched even when Paul's atoms show them, which
pulls must-have coverage down. A model can propose the match; plain code decides whether to
believe it.

## Behavior
1. **Route `job-match`** (`packages/sources/src/fit/model-match.ts`, prompt
   `packages/prompts/prompts/job-match/v1.md`). Input: the requirements the rules left unmatched
   (job text, untrusted, in `untrustedBlock`) and Paul's atoms by id (also untrusted: resume
   text). Output: for each requirement, by its index, an atom id and a verbatim quote from that
   atom, or null for both. No tools.
2. **Provenance check, plain code** (`checkJobMatches`): a proposed match counts only when the
   requirement index is one the input sent, the atom id is in the current import, and the quote
   (3 or more characters, whitespace-normalised) appears verbatim in that atom's text (its
   `what` or one of its `how` terms). Anything else stays unmatched; a requirement proposed twice
   keeps the first.
3. **Scoring.** `scoreJob` takes the accepted model matches: each moves its requirement from
   unmatched to matched, with the quote as its `term` and `by: "model"` in the evidence. The
   rules run first and stay the deterministic floor: the model only sees what they left.
   `scorePending` takes an optional `assist` step; with it, a job whose rules left something
   unmatched is assisted, and a score that used any model match is stored with
   `method: "rules_model"` (a new value, migration). An assist that fails (refusal, bad output,
   breaker, timeout) leaves the rules score, never blocks scoring, and is counted.
4. **Off by default** (ADR-0016 item 8). `assistUnmatched` returns nothing unless the caller
   enables it, and no caller does yet: the fixtures are hand-written, each marked so, and the
   baseline is provisional until Paul records real ones (a `needs:paul` issue).
5. **Cost** is on the call record (OBV-003), as for every route.

## Acceptance criteria
- [ ] A valid proposal moves a must-have from unmatched to matched with `by: "model"` and raises
      must-have coverage; the score is stored with `method: "rules_model"`.
- [ ] A proposal with an unknown atom, a quote not in the atom, or an index the input didn't send
      stays unmatched.
- [ ] Requirements the rules matched are never sent to the model.
- [ ] With the route off, scoring is unchanged and makes no call.
- [ ] A failed assist keeps the rules score and counts the failure.
- [ ] `fit_score.method` accepts `rules_model` and refuses anything else.
- [ ] An eval set in `evals/job-match/` (synthetic cases, hand-written fixtures, provisional
      baseline) runs in `eval --all`.

## Failure modes
- Model refuses, times out or returns garbage: the rules score is stored; the assist failure is
  counted on the span by error name.
- A posting that tries to instruct the model: it's data in `untrustedBlock`; the provenance check
  means it can at most make a requirement match a quote that really is in Paul's atom.

## Observability
- The gateway's `llm.call` span and call record; `fit.assisted` and `fit.assist_failed` counts on
  the `fit.score` span; `method` on the `job.scored` event.

## Out of scope
- Turning the route on in `jobs score` and recording real fixtures (the `needs:paul` issue).
- Re-scoring jobs already scored by rules when the route is turned on (the score key doesn't
  include the method; a follow-up can add a re-score command).

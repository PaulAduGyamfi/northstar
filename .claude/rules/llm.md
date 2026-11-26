---
paths:
  - "packages/llm/**"
  - "packages/prompts/**"
  - "packages/agents/**"
  - "evals/**"
---

# LLM gateway, prompts, agents and evals (ADR-0004, ADR-0006)

`packages/llm` and `evals/` exist since NS-106 (ADR-0013); `packages/prompts` and the first
route (`profile-extract` in `packages/profile`) since NS-110, `story-draft` since NS-111.
`packages/agents` doesn't exist yet. Ask Paul before creating it.

- Load prompts with `loadPrompt(id, version)`. A new or changed prompt is a new file
  (`prompts/<route>/vN+1.md`) plus `pnpm --filter @northstar/prompts lock`; the lock test fails
  if a committed version changes.
- Register every route's eval set in `evals/src/routes.ts`; CI replays them all.
- Never run `profile import-resume`, `profile import-linkedin`, `profile show`,
  `profile interview` or `profile stories` yourself: they read and print Paul's real resume,
  LinkedIn export, profile, answers and stories. Test with the
  synthetic fixtures; Paul runs the real commands.
- The `job-extract` route (NS-114) lives in `packages/sources`; its values pass
  `checkJobProvenance` (dropped, never kept, when the page lacks them). Never run `jobs add` on a
  real link yourself; tests use the fake web in `packages/sources/src/test/fake-web.ts`.
- The `resume-tailor` route (NS-144) lives in `packages/profile/src/tailor/`. Call it only
  through `tailorWithModel`, which checks the output and falls back to the deterministic resume.
  It is off by default (`enabled: true` turns it on), because its fixtures are hand-written.
- The `answer-draft` route (NS-135) lives in `packages/profile/src/answer/`. Every sentence
  cites a story or atom with a verbatim quote, checked by `validateAnswerDraft`. It is off by
  default (`draftAnswer` returns `off` unless the caller passes `enabled: true`), because its
  fixtures are hand-written.
- The `job-match` route (NS-138) lives in `packages/sources/src/fit/model-match.ts`. Call it
  only through `assistUnmatched`, which sends only what the rules left unmatched and keeps a
  proposal only when `checkJobMatches` finds its quote verbatim in a real atom. It is off by
  default (`enabled: true` turns it on), because its fixtures are hand-written.
- The `positioning-thesis` route (NS-152) lives in `packages/profile/src/thesis-draft.ts`. Call
  it only through `draftTheses`, which keeps a candidate only when `thesisProblems` finds
  nothing. It is off by default (`enabled: true` turns it on), because its fixtures are
  hand-written. Never run `profile thesis draft|set|show` yourself: they read Paul's profile.
- The `verification-extract` route (NS-149) lives in `packages/inbox/src/verify/model-pick.ts`.
  Use it only through `modelPick` and the catcher's `offerAssisted`: the model answers with an
  index into the candidates plain code found, never a code or link (VER-005), and the catcher
  checks the choice. Fixtures use placeholder codes (`111111`) and `example.com` links only. It is
  off by default (`enabled: true` turns it on), because its fixtures are hand-written.
- The `question-confirm` route (NS-137) lives in `packages/profile/src/question-confirm.ts`.
  Use it only through `confirmQuestion`: it runs only for a question `matchQuestion` left new as
  `below_threshold` or `ambiguous`, never one nearest a factual question, and the model answers
  with an index into candidates code chose (`confirmCandidates`), which code checks. It is off
  by default (`enabled: true` turns it on), because its fixtures are hand-written. A match it
  returns carries `confirmedBy: "model"`: a caller must never count it as reuse for the Gate's
  policy (`bank_exact` or `bank_high_confidence`), whatever its confidence.
- The `reply-draft` route (NS-166) lives in `packages/profile/src/reply/`. Call it only
  through `draftReply`, which asks only when `replyNeed` says a reply is due and keeps a draft
  only when `validateReplyDraft` passes: claims cite stories or atoms verbatim and add no
  commitment word, time, link or symbol, and framing is one of the fixed `framingSentences`.
  Keep the prompt's list of framing sentences and the code's the same (a test checks). It is off by default (`enabled: true`
  turns it on), because its fixtures are hand-written. Nothing it drafts is ever sent
  (ADR-0025).
- The `recruiter-extract` route (NS-167) lives in `packages/inbox/src/recruiter/`. Call it only
  through `extractRecruiterFacts`, which keeps only values `checkRecruiterFacts` finds in the
  email. It never grades: `gradeRecruiterMessage` in `packages/sources` does, in plain code. It
  is off by default (`enabled: true` turns it on), because its fixtures are hand-written.
- A new route with no real recordings gets hand-written fixtures (ADR-0016 item 8). Write the
  expected outputs to `evals/<route>/handwritten.jsonl` and run
  `node evals/dist/handwrite-bin.js <route>` (after building `evals`). Each fixture is marked
  `handWritten` and has its real request key. The baseline is provisional until Paul runs
  `--record` and `--live --update-baseline`.
- The `mail-classify` route (NS-113) lives in `packages/inbox`. Never run any `funnel` command
  yourself: they read Paul's real Gmail and print his real applications.

- Call the model only through `createLlmGateway(...).call(route, input)`. Handle every
  `LlmOutcome` kind (`Ok`, `Refused`, `Truncated`, `InvalidOutput`). Let `LlmTransportError`
  throw so Temporal retries it. Put the `CallRecord` in the domain event.
- In a CLI or service, pass the gateway a `guard` wired to the stored kill switches and breakers
  (NS-174), as the funnel and sources CLIs do. Let its `HeldBack` throw, like a transport error:
  the call never went out, and it is retryable.
- Wrap untrusted text with `untrustedBlock(kind, text)` in the route's volatile part.
- Only `packages/llm` imports `@anthropic-ai/sdk`. Agents call the gateway, never the SDK.
- Default model `claude-opus-5-5` with adaptive thinking and an explicit `effort` per route.
  A cheaper tier needs an eval result and an amendment to ADR-0006.
- Every agent result is a structured output validated with its Zod schema on arrival. Check
  `stop_reason` (including `refusal`) before reading content.
- Prompts are versioned files (`prompts/<route>/vN.md`), never edited in place once committed. Stamp prompt version and
  model on every output.
- Stable prefix first for caching: system prompt, then profile-graph summary, then voice guide,
  then the volatile job or email.
- Untrusted text (JDs, emails, web pages) goes in clearly delimited data blocks, and agents that
  read it get no side-effect tools.
- Generated claims cite atom or story IDs; the provenance validator is plain code and runs after
  every generation.
- Meter tokens, cache hits, cost and latency per call (OBV-003). Respect the budget caps (RES-009):
  give every new route a deliberate `priority` (ADR-0021; default `normal`), and pass the gateway
  a `budget` (`loadLlmBudget` and `dbSpendMeter`) in every CLI or service, like the guard. Let a
  `HeldBack` by `budget` throw: the call never went out and is retryable.
- Tests use recorded fixtures, never a real model. Evals are the only place real model calls run,
  and only on purpose (they cost money).
- A prompt or model change needs Paul's `eval <route> --live` run. Commit the new
  `baseline.json`, re-record the fixtures with `--record`, and paste the output in the PR. CI only
  replays.
- Recorded fixtures are public. Record only synthetic inputs, and keep real-mail cases in
  `evals/**/private/`. The eval CLI has no private mode yet: it reads only
  `<route>/cases.jsonl` and writes fixtures to the public `<route>/fixtures/`. Never put a
  real-mail case there or run `--record` on one.

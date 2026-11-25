# NS-149: LLM extraction fallback for verification mail

Status: accepted (autonomous lane, ADR-0016)
Requirements: VER-003 (with VER-004, VER-005)
Rules that apply: ADR-0010, ADR-0013, ADR-0016 (item 8), `.claude/rules/llm.md`
Parent: #22 (NS-123)

## Why
NS-123's catcher extracts codes and links with plain code. When a matched message has two
candidate codes (or no code and two links), the window becomes `needs_human`
(`ambiguous_content`). VER-003 allows a model fallback on that mismatch, as long as the same
pattern rules validate what it returns.

## Behavior
1. **Route `verification-extract`** (`packages/inbox/src/verify/model-pick.ts`, prompt
   `packages/prompts/prompts/verification-extract/v1.md`). Input: the email body (untrusted, in
   `untrustedBlock`) and the candidates plain code already found, numbered. Output:
   `{ choice: <index> | null }`. The model only **chooses**: its output is an index, never a code
   or link, so nothing secret is in its output, the call record or a fixture's response (VER-005).
   No tools.
2. **Catcher.** `offer` is unchanged. A new `offerAssisted(message, pick)` behaves the same,
   except that on ambiguous content it awaits `pick` with the candidates (the codes when there
   are several, otherwise the links):
   - a valid index picks that candidate; a link must still pass `checkLink` against the window's
     link hosts (VER-004), or the window becomes `needs_human` (`link_host_not_allowed`);
   - null, an index out of range, a pick that throws, or a window that closed while waiting
     ends as `needs_human` (`ambiguous_content`), exactly as without a fallback;
   - the span records the outcome and whether the model was asked, never the code or link.
3. **Off by default** (ADR-0016 item 8): `modelPick({ gateway, enabled })` returns a pick that
   answers null without a call unless `enabled` is true, and no caller enables it yet. Fixtures
   are hand-written, the baseline provisional, and a `needs:paul` issue asks Paul to record them.
4. **Fixtures use placeholder codes** (`111111`, `222222`) and `example.com` links only.

## Acceptance criteria
- [ ] Two codes in a body: with a pick choosing index 1, the second code is returned as a
      `VerificationSecret`; with no pick or a null pick, `needs_human` (`ambiguous_content`).
- [ ] An index out of range, or a pick that throws, ends as `needs_human` (`ambiguous_content`).
- [ ] Two links: a chosen link on a non-allowed host is `needs_human` (`link_host_not_allowed`).
- [ ] A message that isn't ambiguous never calls `pick`.
- [ ] `modelPick` is off by default and makes no call; it maps every gateway outcome; the route
      puts the body and candidates in untrusted blocks.
- [ ] No span attribute or feed line contains a code or link.
- [ ] Eval set `evals/verification-extract/` (synthetic, hand-written fixtures, provisional
      baseline) runs in `eval --all`.

## Failure modes
- Model down, refusing or wrong: `needs_human`, as before this ticket. A wrong pick can only be
  another candidate plain code found in the same authenticated, allowlisted email, and a link
  still needs the host check.

## Out of scope
- Turning it on (the gateway session, NS-124/NS-151) and recording real fixtures (`needs:paul`).

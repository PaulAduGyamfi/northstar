# NS-192 slice 5: review follow-ups (parity, span, framework-tracked inputs)

Status: in progress (autonomous lane, ADR-0016)
Requirements: APPLY-006, OBS-001 · ADR-0029, ADR-0030
Rules that apply: `.claude/rules/extension.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`.
Issue #161. Slices 1–4: #318, #328, #333, #337.

## Behavior
- **Parity.** `apps/extension/src/prefill.ts` exports `ADAPTERS`. `packages/gateways`'
  `apply/prefill-parity.test.ts` loads it by path and checks, for every ATS in `APPLY_ATS`: the
  same set of ATSes, the same hosts, the same contact fields with and without a phone, and the
  same file fields (resume, then cover letter where the adapter has one).
- **Span.** When `recordPrefill` throws, `POST /handoffs/package` sets
  `northstar.prefill.record_error` to the error's class name (`errorClassOf`: a plain identifier,
  else `Error`; never the message). The answer stays `503 prefill_unrecorded`.
- **Framework-tracked inputs.** `fillForm` sets a text input's or textarea's `value` through its
  prototype's own setter when there is one. A safety net: in Chrome's isolated world, where the
  popup injects, assignment already reaches the native setter; it matters where a shadowed `value`
  is visible (tests, or a future main-world injection).

## Acceptance criteria
- [ ] The parity test fails if a host, contact field or file field differs.
- [ ] A thrown write puts its class name, not its message, on the span.
- [ ] `fillForm` uses the prototype setter, not a shadowing one.

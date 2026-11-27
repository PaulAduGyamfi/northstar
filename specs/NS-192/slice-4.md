# NS-192 slice 4: the pasted pre-fill code (card and popup)

Status: in progress (autonomous lane, ADR-0016)
Requirements: APPLY-006, ACC-007 · ADR-0030 (amends ADR-0029's hand-off), ADR-0029, ADR-0003, ADR-0019
Rules that apply: `.claude/rules/extension.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`.
Issue #161 (Parent #20). Slices 1–3: #318, #328, #333. Decision: #332 (option B).

## Why
Slices 2–3 built the grant, the package read and the extension's fill logic, but nothing hands the
grant from Paul's session to the extension. #332 decided: a one-time code Paul pastes. It adds no
permission, and the grant never lands in a URL, history or extension storage.

## Behavior
- **ADR-0030** records option B and amends ADR-0029's "deep link" sentence.
- **The code** is `<handoffId>.<grant>` (a UUID, a dot, the 43-character base64url grant).
  `prefillCode` (apps/web) builds it; `parsePrefillCode` (apps/extension) trims whitespace and
  accepts only that exact shape, else nothing is sent.
- **The card** (`NeedsYourHands`): a "Pre-fill" button per handoff calls
  `POST /api/handoffs/prefill-grant`. On success it shows the code in a read-only field, a Copy
  button (`navigator.clipboard.writeText`) and a countdown to `expiresAt`; at 0 the code is cleared
  and the card says to start again. Refusals (`not_found`, `closed`, `no_package`, `not_approved`,
  `changed`, 401) get plain sentences (`grantMessage`). The code lives in component state only.
- **The popup**: below "Save to Northstar", a paste field and a "Fill this form" button. On click:
  1. read settings (as capture does) and parse the code; a bad code sends nothing;
  2. `packageRequest` → `POST /handoffs/package`; a refusal shows `prefillMessage(error)`;
  3. re-read the active tab's URL right before injecting, and run `prefillPlan(pkg, url)`;
  4. inject `fillForm(fills)` into that tab id's main frame only (`frameIds: [0]`) and show
     `filledMessage`. The field is cleared after every attempt; nothing is stored.

  The popup logic is a plain function (`runPrefill`) over ports, tested with fakes; `popup.ts`
  only wires it. The tabs type gains `url` (activeTab grants it after Paul's click).
- Manifest unchanged; `manifest.test.ts` unchanged.

## Acceptance criteria
- [ ] `parsePrefillCode` accepts exactly a UUID, a dot and a 43-char base64url grant (trimmed).
- [ ] `runPrefill` sends nothing for a bad code or missing settings; shows the API's refusal;
      refuses a tab the plan refuses without injecting; injects into the main frame of the tab
      whose URL it checked; reports counts only.
- [ ] The card shows the code, copies it, counts down and clears it at 0; refusals read plainly.
- [ ] No storage, cookie or URL holds the grant; the manifest and its test are unchanged.
- [ ] AGENTS.md, `.claude/rules/extension.md` and `.claude/rules/gateways.md` describe the flow.

## Out of scope
A parity test with `packages/gateways`' adapters; React-controlled input setters; the error class
on the failed-event span (review follow-ups listed on #161).

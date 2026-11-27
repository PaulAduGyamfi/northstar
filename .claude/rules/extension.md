---
paths:
  - "apps/extension/**"
---

# Chrome extension (MV3)

`apps/extension` exists since NS-128 ("Save to Northstar"). Plain TypeScript compiled by `tsc`,
no bundler or framework; `src/chrome.d.ts` types the few Chrome APIs it calls.

- Minimal permissions: today `activeTab`, `scripting`, `storage` and `http://127.0.0.1/*` (the
  local API, any port). `manifest.test.ts` pins them; any new permission needs a reason in the plan.
- Capture is user-initiated: no background page, no content scripts, no crawling of LinkedIn or
  Indeed (ADR-0003). The page is read only when Paul clicks.
- Never store third-party passwords. The handoff opens a pre-filled form in Paul's own session.
- Talks only to the Northstar API on 127.0.0.1, with its own scoped token (`auth: "extension"`,
  ADR-0019). Page content sent to the API is untrusted data.
- Plain logic (what is captured, the request, the messages) lives in modules with tests;
  `popup.ts` and `options.ts` only wire it to the browser.
- The handoff pre-fill (NS-192) follows ADR-0029 option 2 (Accepted): the extension may read one
  open handoff's approved package only with a one-time, 2-minute grant from Paul's own session;
  the extension token alone reads nothing. Since slice 2 that read is `POST /handoffs/package`
  with a grant from `POST /handoffs/prefill-grant` (`apps/api/src/prefill.ts`): send the grant,
  never store it, and never widen the read beyond that one handoff. Never add an `auth: "extension"`
  endpoint that reads Paul's data without an accepted ADR. The fill sets only fields the ATS
  adapter maps, on Paul's click, on the adapter's own host, never submit, never the challenge.
  Since slice 4 (ADR-0030) the grant arrives as a code Paul pastes into the popup
  (`prefill-run.ts`: `<handoffId>.<grant>`, held in memory only, the field cleared after each
  try). Re-read the tab's URL right before injecting, inject into that tab id's main frame only
  (`frameIds: [0]`), and let `fillForm` re-check the page's host and path (`fillTarget`). The code
  shape is shared with `apps/web`'s `prefillCode`: change both together.
- The capture request carries a time limit (`CAPTURE_TIMEOUT_MS`, 5 min, NS-176); any new request
  from the extension needs one too (RES-005).

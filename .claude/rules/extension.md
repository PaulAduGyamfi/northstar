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
  ADR-0018). Page content sent to the API is untrusted data.
- Plain logic (what is captured, the request, the messages) lives in modules with tests;
  `popup.ts` and `options.ts` only wire it to the browser.

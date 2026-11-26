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
- The handoff pre-fill (NS-192) reads the approved package only from `POST /handoffs/package`
  (extension token), which re-checks the handoff, the approval and the hash on the server. Slice
  2 fills from it: only fields the ATS adapter maps, on Paul's click, never submit, never the
  challenge.
- The capture request carries a time limit (`CAPTURE_TIMEOUT_MS`, 5 min, NS-176); any new request
  from the extension needs one too (RES-005).

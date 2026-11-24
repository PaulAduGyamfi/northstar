---
paths:
  - "apps/extension/**"
---

# Chrome extension (MV3)

This doesn't exist yet. If you are about to create it outside its ticket, stop and ask Paul.

When it lands:

- Minimal permissions. `activeTab` and user-initiated actions over broad host permissions; any
  new host permission needs a reason in the plan.
- Capture is user-initiated: no background crawling of LinkedIn or Indeed (ADR-0003).
- Never store third-party passwords. The handoff opens a pre-filled form in Paul's own session.
- Talks only to the Northstar API, with its own scoped token. Page content sent to the API is
  untrusted data.

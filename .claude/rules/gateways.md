---
paths:
  - "packages/gateways/**"
  - "packages/ats-adapters/**"
  - "packages/sources/**"
---

# Action gateways, ATS adapters and job sources (ADR-0002, ADR-0003, ADR-0007)

None of these exist yet. If you are about to create one outside its ticket, stop and ask Paul.

When they land:

- A gateway call without a verified `approvalId` or `policyDecisionId` throws. Look the approval
  up server-side; never trust an ID the caller merely asserts. Test the refusal.
- Every side effect has an idempotency key (`application:{id}:submit`, `email:{draftId}:send`).
  A retry after a crash must not double-submit or double-send; prove it with a test.
- Timeouts, jittered retries and a circuit breaker per dependency (each ATS domain, Gmail,
  Calendar, GitHub). Breaker state shows up in the health model.
- Adapters fail into quarantine and assisted apply, never into a silent drop.
- No CAPTCHA solving, stealth plugins, fingerprint spoofing or credential storage. A challenge
  returns `needs_human` with a deep link.
- Human pacing: one submission at a time per ATS domain, with daily caps.
- Job sources declare their terms status (`official-api`, `public-feed`, `user-session-capture`,
  `prohibited`). `prohibited` can't be enabled.
- Tests run against recorded fixtures of ATS pages and APIs, never the live site.

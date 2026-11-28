---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/tests/**"
  - "**/__fixtures__/**"
---

# Tests

- One promise per test, named as a sentence (`submitting twice sends one application`).
- Assert exact values, not "truthy".
- To prove "safe to repeat", run the operation twice and compare.
- To prove a gateway refuses, call it without an approval and assert the specific error.
- No real network, model, Gmail, Calendar, GitHub or ATS. Use recorded fixtures and fakes.
  The one exception is Temporal's test server, downloaded from `temporal.download` by the
  worker's `temporal.test.ts` (NS-224); never add another host without Paul.
  No sleeps; use fake timers or Temporal's test environment.
- Fixtures are synthetic: `example.com` emails, invented people and companies, fake keys
  (`test-key`). **The repo is public**, so never paste a real email, resume or job thread.
- Never delete, skip or loosen a test to get green without Paul's written approval in the plan.

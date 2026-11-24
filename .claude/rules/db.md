---
paths:
  - "packages/db/**"
---

# Database schema and migrations (Postgres 16 + pgvector, Drizzle)

This doesn't exist yet. If you are about to create it outside its ticket, stop and ask Paul.

When it lands:

- Migrations are generated, reviewed and committed. Never edit an applied migration; add a new one.
- Backward-compatible changes: expand, migrate, contract (RES-011).
- The database guards the data: NOT NULL, CHECK, foreign keys and unique constraints
  (requisition dedupe, idempotency keys) in the schema, not only in TypeScript.
- Every row belongs to a `candidate_id` (Q-02: single tenant now, no shortcuts).
- Approval records and events are append-only.
- Queries use parameters, never string-built SQL.
- Tests only touch databases whose name ends in `_test`.

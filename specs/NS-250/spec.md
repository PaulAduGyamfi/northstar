# NS-250: share one Google GET helper between the Gmail and Calendar clients

Status: building (autonomous lane, ADR-0016)
Requirements: RES-002, RES-003 (ADR-0007), ADR-0014, ADR-0026
Issue #306 (Parent: #271).

## Why
`packages/inbox/src/calendar/client.ts` copied about 80 lines of `src/gmail.ts`'s GET plumbing.
The copy drifted twice before review brought it back (`Retry-After` and the `ErrorInfo` reason).
One helper can't drift.

## Behavior
- **`createGoogleGet(config, deps)`** (`src/google-get.ts`, outside `src/calendar/`) returns one
  `get(url, span)` that does what both clients did:
  - the `config.dependency` breaker through `admit`: held back throws `HeldBack` with nothing
    sent; after the retries it reports a failure only for the service's own trouble;
  - up to 5 retries of a dropped connection, 429, 5xx and rate-limit 403s, honouring
    `Retry-After` up to 60 s, else 500 ms or (rate limit) 2 s doubling, plus up to 250 ms jitter;
  - `errorReason`: Google's `ErrorInfo` reason, then the legacy reason, then the status word;
  - errors built by the client's own class, messages starting with `config.label`, span attributes
    under `config.attrPrefix`, and the breaker's error name `config.errorName`.
- **What stays per client:** Calendar's `requestAllowed` check (run first, inside the breaker, as
  before), its explicit `method: "GET"`, and its own error for a 200 body that isn't JSON. Gmail
  keeps returning `res.json()` as before.
- **No behaviour change:** every existing Gmail and Calendar test passes with no assertion edited.
  The Calendar boundary scan still lists only `access.ts` and `client.ts`.

## Acceptance criteria
- [ ] The helper is tested directly: `Retry-After`, a rate-limit 403, a dropped connection, and a
      404 that is reported to the breaker as an answer (`ok: true`).
- [ ] Both clients use it; neither holds its own retry loop, `errorReason` or breaker wrapper.
- [ ] Every existing Gmail and Calendar test passes unchanged.
- [ ] `pnpm turbo run lint typecheck test build --filter=@northstar/inbox` passes.

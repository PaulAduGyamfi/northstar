# ADR-0023 — `packages/pipeline` for plain-code pipeline steps

**Status:** Accepted (agent, under ADR-0016; decision recorded on #182 under Paul's delegation) · **Date:** 2026-11-26

## Context
NS-161 assembles application packages. Assembly combines the tailored resume, Paul's factual
settings and his banked answers (`packages/profile`), the job (`packages/sources`/`db`) and the
package schema (`packages/domain`). It then files the package with the Approval Gate
(`packages/db`). The system design puts long-running steps in `apps/worker` (ADR-0001), but the
step itself has no reason to depend on Temporal. A package that every other one imports would
also create cycles.

## Decision
- A new `packages/pipeline` holds the pipeline's plain-code steps: pure functions (inputs in,
  result out, no model, no network) plus thin callers that write through `packages/db`'s own
  write paths.
- The first steps are `assemblePackage` and `filePackage` (NS-161). `apps/worker` calls the same
  functions from its activities; the CLIs and tests call them directly.
- It may depend on `domain`, `db` and `profile`. Nothing below it (`domain`, `db`, `profile`,
  `sources`, `gateways`) may depend on it.
- It never submits, sends or calls a model. Anything that acts for Paul stays in
  `packages/gateways` behind the Gate (ADR-0002).

## Alternatives considered
- **Inside `apps/worker`:** ties a pure step to Temporal, and the CLIs couldn't reuse it.
- **Inside `packages/profile`:** profile is about Paul's profile; assembly also needs jobs and
  the Gate, and would grow profile's dependencies.
- **Inside `packages/gateways`:** gateways act for Paul. Assembly only proposes.

## Consequences
- + Assembly is testable without a server and reusable from the worker and the CLIs.
- − One more package to build and keep in the dependency order.

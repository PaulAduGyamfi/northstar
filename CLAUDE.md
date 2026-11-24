# CLAUDE.md — instructions for coding agents in this repo

## Read before writing code
1. `docs/00-vision.md` — what success means.
2. The requirement doc for the capability you are touching (`docs/requirements/NN-*.md`). Cite requirement IDs (e.g. `APPLY-004`) in commit messages and PR descriptions.
3. `docs/architecture/system-design.md` and any ADR referenced by that requirement.

## Hard rules (these come from the product owner and the ADRs — do not relax them)
- **Human-in-the-loop gates are architecture, not UI.** Anything that sends a message, submits a form, or publishes content under the user's name must pass through the Approval Gate (ADR-0002). The only exception is an explicit, user-configured auto-approve policy, and that policy check lives server-side.
- **Never fabricate experience.** Generated resume bullets and answers must trace to a source record in the Candidate Profile Graph (ADR-0004). If no source exists, the output says so and asks.
- **No CAPTCHA solving, fingerprint spoofing, or credential stuffing.** When a site challenges automation, hand off to the user (ADR-0003).
- **Respect source terms.** Prefer official/public ATS APIs; do not add scrapers for sites whose terms forbid it without an ADR.
- **Secrets** (OAuth tokens, API keys) live only in the secrets store, encrypted at rest; never log them, never put them in prompts.
- **Every agent action emits an event** to the activity log (requirement OBS-001). If it isn't in the feed, it didn't happen.

## Conventions
- TypeScript everywhere (ADR-0005) unless an ADR says otherwise.
- Claude models: default `claude-opus-5-5`; cheaper tiers only where an ADR records the measured trade-off.
- Prompts live in `packages/prompts/` as versioned files, never inline string literals in business logic.
- Every LLM feature ships with a small eval set in `evals/<feature>/`.

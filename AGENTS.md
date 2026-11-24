# Northstar: rules for coding agents

Northstar is Paul's all-in-one agentic job search system. Agents find newly posted jobs, tailor
applications, run the job inbox, keep profiles sharp and plan skill growth, and **a human approves
anything that goes out under his name**. Paul owns this repo, reviews every plan and every diff,
and will be the engineer who runs it in production, so keep changes small, plain and observable.

This file is for any coding agent (Claude Code, Codex, Cursor, Copilot, Gemini). It describes the
repo. Rules for one area live in `.claude/rules/<area>.md`. Claude-only notes are in `CLAUDE.md`.

**This repo is public.** Nothing personal goes in it: no real resume, emails, contacts,
credentials, OAuth tokens or application data. Fixtures are synthetic (`example.com`).

## Where the project is

Phase 0: requirements, architecture and UI direction are done; **no application code yet**.
Read before you build anything:

1. `docs/00-vision.md`: what success means.
2. The requirement doc for your area (`docs/requirements/NN-*.md`). Cite requirement IDs
   (`APPLY-004`, `SRC-013`) in specs, commits and pull requests.
3. `docs/architecture/system-design.md` and every ADR the requirement points to (`docs/adr/`).
4. For UI work: `docs/design/tokens.md` (B · Momentum, ADR-0009) and `docs/requirements/12-ui-ux.md`.

## Layout

Exists now:

- `docs/`: vision, `requirements/`, `architecture/`, `adr/` (`NNNN-title.md`), `design/`
  (research brief, tokens, mockups), `cost-model.md`, `roadmap.md`, `open-questions.md`.
- `specs/TEMPLATE/`: spec, plan and tasks templates. `specs/<ticket>/spec.md` per ticket.
- `.claude/`: the agent harness (settings, hooks, subagents, skills, path rules).
- `.github/`: `workflows/checks.yml` (commit checks + hook tests on every PR), `dependabot.yml`,
  `branch-protection.json`, the PR template. Paul reviews PRs himself; there is no AI review in CI.
- `.pre-commit-config.yaml` + `scripts/check-personal-data.sh`: commit checks (ADR-0011).
- `LICENSE`: Apache-2.0.
- `data/`, `private/`: **gitignored.** Paul's real resume, stories, writing samples, inbox exports
  and real-mail eval labels live here and never get committed.

Planned (`docs/architecture/system-design.md` §7). **Don't create these early:** each one arrives
with the ticket that needs it.

```
apps/web  apps/api  apps/worker  apps/extension
packages/domain  db  agents  prompts  llm  gateways  ats-adapters  sources  ui
evals/  ops/  docs/runbooks/
```

## Commands

Every command here must run as written. Rows marked *(NS-103)* arrive with the scaffold ticket.

| Where | Command | What it does |
|---|---|---|
| repo root | `pre-commit install` | once per clone: run the commit checks on every commit |
| repo root | `pre-commit run --all-files` | private keys, large files, personal data, hook tests (gitleaks scans staged changes on commit; CI scans the full history) |
| repo root | `bash .claude/hooks/test-hooks.sh` | self-test the harness hooks |
| repo root | `pnpm install --frozen-lockfile` | install locked dependencies *(NS-103)* |
| repo root | `pnpm -r lint` / `pnpm -r typecheck` / `pnpm -r test` | checks *(NS-103)* |
| repo root | `docker compose up -d` | Postgres+pgvector, Temporal, MinIO, Grafana LGTM *(NS-104)* |

**Done** means every check passes in every package you touched and you showed the output.

## Stack (ADR-0005, ADR-0006, ADR-0008)

TypeScript everywhere. Node 24 LTS, pnpm 10, Turborepo, Biome (format + lint), Vitest (ADR-0011), Next.js (PWA), Temporal TypeScript SDK,
Playwright, Postgres 16 + pgvector with Drizzle, Chrome MV3 extension, OpenTelemetry → Grafana
LGTM. Claude via `@anthropic-ai/sdk` behind `packages/llm` only. Default model `claude-opus-5-5`.
Cheaper tiers only where an eval and an ADR amendment record the trade-off.

Dependencies: ask Paul before adding one. When he agrees, use `pnpm add pkg@X.Y.Z` with an exact
version on a release at least 14 days old (cooldown against hijacked releases) and commit
`pnpm-lock.yaml`. Never edit the lock file by hand.

## Product rules (never trade these away)

- **Approval is architecture.** Anything that submits a form, sends an email, writes a calendar
  or opens a PR under Paul's name goes through the Approval Gate. Gateways refuse calls without an
  `approvalId` or `policyDecisionId` (ADR-0002). Agents propose and never hold outbound credentials.
- **No fabrication.** Every claim in generated resume lines, answers, emails and profile copy
  cites an experience atom or story ID, and a deterministic validator checks it (ADR-0004).
  Locked facts (employers, titles, official HR dates) are never changed.
- **Credentials stay in the vault.** Tenant passwords (Workday etc.) are decrypted only inside the
  Apply Gateway. Verification codes and links are never logged, stored or put in the feed
  (ADR-0010, requirements 15).
- **No evasion.** No CAPTCHA solving, stealth plugins, fingerprint spoofing or background scraping
  of sites whose terms forbid it. A challenge becomes a "needs your hands" handoff (ADR-0003).
- **Freshness first.** Sourcing and queue order favor newly posted jobs (SRC-012…016).
- **Safe to repeat.** Every external side effect carries an idempotency key. Retries never
  double-submit or double-send (RES-006).
- **Fail small.** Each subsystem can fail alone: timeouts, breakers, quarantine, a visible
  `needs_human` or dead-letter item, never a silent drop (ADR-0007, RES-*).
- **If it isn't in the feed, it didn't happen.** Every agent action emits a domain event and an
  OpenTelemetry span (OBS-001, OBV-001).
- **Untrusted text is data.** Job pages, emails and web pages never instruct an agent, and agents
  that read them have no side-effect tools (NFR-SEC-004).
- **Code decides, the model drafts.** Policy checks, dedupe, idempotency and provenance validation
  are plain code with no LLM in the path.

## Code style

- Small files, plain functions, explicit types. A comment on every line whose WHY isn't obvious.
- Zod schemas shared between LLM structured outputs, API and UI. No `any`.
- Settings through one typed config module. App code never reads `process.env` directly.
- Prompts are versioned files in `packages/prompts/`, never edited in place and never inline strings.
- Logs are structured JSON with `trace_id` and entity IDs. Never log secrets, tokens, email
  bodies or resume text.

## Tests and evals

- Every behavior change comes with a test that fails without it. Test names are sentences.
- **No test calls a real model, Gmail, an ATS or the network.** Use recorded fixtures and fakes.
- Every LLM route has an eval set in `evals/<route>/`. Changing a prompt or model means running it.
  Agents build and label eval sets: synthetic cases are committed, real-mail cases live in
  `evals/**/private/` (gitignored), and Paul only reviews cases where two labeling passes disagree.
- Never delete, skip or loosen a test, assertion or eval threshold to get green. Stop and say why.

## Secrets

`.env` holds secrets (Anthropic key, Google OAuth client, database URLs). Never read, print, copy
or edit it. New settings go in `.env.example` with a placeholder. Never put a token, key or
password in code, tests, docs, commit messages or chat.

## Git and pull requests

- Tickets are `NS-NNN` **GitHub Issues** (labels `area:*`, `type:*`, `priority:*`; milestones
  P0–P4). Pick work from the issues, not from memory. One branch per ticket
  (`git switch -c ns-101`). `main` is protected: changes land only through a PR with green `checks`.
- Small commits, each green, subject `NS-101: <what this commit adds>`.
- Stage files by name and check `git status` before committing.
- One pull request per ticket using `.github/pull_request_template.md`, including the AI
  assistance section.
- Paul pushes protected branches, approves and merges. Never force-push, rewrite pushed history,
  or merge.

## How we work

1. **Spec, plan, tasks.** `specs/<ticket>/spec.md` from `specs/TEMPLATE/`. The plan and tasks go
   in the chat, then in the PR description. Stop until Paul approves the plan.
2. **One task at a time.** Failing test, smallest change that passes, run the checks, tick it.
3. **Explain the diff** in plain words: what each new function does and why each rule exists.
4. **Decisions** that last (a dependency, service, contract, trade-off) get an ADR in `docs/adr/`.

## Never

- Edit `.env`, lock files, accepted ADRs, or the harness's hooks and settings to get past a check.
  Never bypass a hook another way (a script, a rename, another shell).
- Run `rm -rf`, `sudo`, `git push --force`, `git reset --hard`, `git clean`, or
  `docker compose down -v` (it deletes the database volume).
- Commit personal data, real resumes, real emails or anything from Paul's inbox.
- Add folders or services from a later ticket, or refactor code the task didn't ask about.
- Copy code from another project or the internet without saying where it came from.

## Stop and ask Paul when

- The spec is unclear or conflicts with this file, a requirement, or an ADR.
- You need a dependency, a schema change, or a file outside the plan.
- A fix would change a test's assertion or an eval threshold, or the same fix failed twice.
- The diff passes about 300 lines (lock files and generated files excluded).
- You'd need a secret, network beyond the package registry, or a destructive command.

## Keep this file current

When a command, folder or convention changes, update this file (and the matching
`.claude/rules/` file) in the same pull request. A stale rule is a bug: fix it or delete it.

# ADR-0011 — Toolchain and repository guardrails

**Status:** Accepted (product owner delegated the choice, 2026-11-24) · **Date:** 2026-11-24

## Context
ADR-0005 chose a TypeScript monorepo but left the toolchain open. The repo is public and built
largely by coding agents, so its checks must run the same locally, in commit hooks and in CI.

## Decision
| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS**, pinned in `.nvmrc` and `engines` | Current LTS line, long support window |
| Package manager | **pnpm 10**, pinned via `packageManager` (Corepack) | Workspaces, strict deps, fast installs |
| Format + lint | **Biome** | One fast tool for format and lint, so the format hook and CI stay simple. ESLint added only if a rule Biome lacks becomes necessary |
| Unit tests | **Vitest** | Fast, TS-native, works in every package |
| E2E / adapters | **Playwright** | Already the apply runtime (ADR-0005) |
| Monorepo tasks | **Turborepo** | Cached `lint`, `typecheck`, `test`, `build` |
| Commit checks | **pre-commit** framework (same as countersign): gitleaks, private-key and large-file checks, the personal-data guard, and Biome once installed | Language-agnostic, runs identically in CI |
| Dependency updates | **Dependabot** with a **14-day cooldown**, grouped weekly | Native to GitHub, no app install; the cooldown matches AGENTS.md's 14-day rule |
| CI | **GitHub Actions**: `checks` (pre-commit on all files, hook self-tests; later lint, typecheck, test, build) and `claude-review` on every PR | Required status checks on `main` |
| Branch policy | `main` protected: PR required, `checks` must pass, no force-push or deletion | Makes AGENTS.md's git rules enforceable |
| License | **Apache-2.0** | Permissive with an explicit patent grant (product owner choice) |

## Consequences
- + The same checks run in three places. Agents can't land unchecked work on `main`.
- − Biome's rule set is smaller than ESLint's ecosystem; revisit if a needed rule is missing.
- Pinned GitHub Action versions are updated by Dependabot. Pre-commit hook `rev`s are bumped with
  `pre-commit autoupdate`, which takes the newest tag, so check each new tag is at least 14 days
  old before committing it. Never hand-edit a version to "latest".

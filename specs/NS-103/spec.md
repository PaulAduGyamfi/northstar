# NS-103: Monorepo scaffold: Node 24, pnpm 10, Turborepo, Biome, Vitest, CI build steps

Status: approved by Paul (2026-11-24; option A, pnpm 10)
Requirements: ADR-0005 (TypeScript monorepo), ADR-0011 (toolchain and guardrails). GitHub issue #4.
Rules that apply: AGENTS.md (dependencies, commands, "don't create folders early"),
`.claude/rules/tests.md`, ADR-0011's 14-day cooldown.

## Why
Every later ticket needs somewhere to put TypeScript and one way to check it. Today the repo has
no `package.json`, so `/verify`, the format hook and CI have nothing to run. After this ticket,
`pnpm install --frozen-lockfile` then `pnpm turbo lint typecheck test build` works the same on
Paul's machine, in the commit hook and in CI, and every ticket after this one only adds packages.

## Behavior
- The repo root is a pnpm 10 workspace (`pnpm-workspace.yaml` lists `apps/*` and `packages/*`),
  with Node 24 LTS pinned in `.nvmrc` and in `engines`, and pnpm pinned with `packageManager`
  (Corepack).
- Every dependency is pinned to an exact version at least 14 days old. pnpm itself enforces the
  cooldown (`minimumReleaseAge` in `pnpm-workspace.yaml`), so an install that would pull a release
  younger than 14 days fails instead of quietly installing it.
- Turborepo runs `lint`, `typecheck`, `test` and `build` across packages, with caching.
- Biome formats and lints every TS/JS/JSON file from one root `biome.json`. The existing
  `format-ts.sh` hook starts working as soon as `node_modules/.bin/biome` exists.
- A shared strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, no implicit `any`)
  that packages extend.
- Vitest is the test runner in every package.
- CI (`checks`) installs with `--frozen-lockfile` before the existing gitleaks, pre-commit and
  hook-test steps (pre-commit's Biome hook needs `node_modules`), then runs
  `pnpm turbo lint typecheck test build` last. Installing early runs no third-party code: pnpm
  doesn't run dependency build scripts (`strictDepBuilds`, empty allow-list), and the job has a
  read-only token and no secrets.
- pre-commit runs `biome check` on staged files (ADR-0011 "Biome once installed").
- Dependabot also watches npm, with the same 14-day cooldown and weekly grouping.
- AGENTS.md's command table no longer marks the pnpm rows *(NS-103)*.

## Acceptance criteria
- [ ] `node --version` under the repo's `.nvmrc` prints `v24.*`.
- [ ] `corepack pnpm --version` in the repo prints the pinned `10.x` version.
- [ ] `pnpm install --frozen-lockfile` succeeds on a clean clone.
- [ ] `pnpm turbo lint typecheck test build` exits 0.
- [ ] `pnpm exec biome check .` reports no problems. A file with a formatting error makes it fail
      (shown once by hand, not committed).
- [ ] A deliberate type error in a package makes `pnpm turbo typecheck` fail (shown once by hand).
- [ ] `pre-commit run --all-files` passes, with the new Biome hook included.
- [ ] `bash .claude/hooks/test-hooks.sh` still passes.
- [ ] `checks` is green on the PR, and its log shows the install and turbo steps ran.
- [ ] `grep -c '(NS-103)' AGENTS.md` prints `0`.

## Failure modes
- **npm registry slow or down:** install fails loudly. CI goes red, and nothing merges with a
  partial `node_modules`. Re-run when the registry recovers. No silent fallback to an unlocked
  install.
- **A dependency release younger than 14 days:** pnpm refuses it (`minimumReleaseAge`). Pick an
  older exact version. Never lower the setting.
- **Lockfile out of date with `package.json`:** `--frozen-lockfile` fails in CI and the PR can't
  merge.
- **A lockfile edited by hand or in a PR:** `--frozen-lockfile` doesn't re-check release ages, so
  `minimumReleaseAge` only guards `pnpm add`/`update`. The lockfile diff in review (and
  Dependabot's own cooldown) is the gate for everything else.
- **A dependency that needs an install script:** `strictDepBuilds` fails the install and names
  it. Allowing it means adding it to `onlyBuiltDependencies`, with Paul's approval.
- **Wrong Node or pnpm version locally:** `engines` plus `engine-strict` make install fail with the
  required version named, instead of building with the wrong one.
- **Turbo cache gives a stale result:** `pnpm turbo ... --force` re-runs without the cache. CI
  starts with no cache.

## Observability
None at runtime: no services or agents yet. CI logs every step's summary line. OpenTelemetry
arrives with NS-104 and NS-105.

## Out of scope
- Any app or package with behavior (`apps/*`, `domain`, `db`, `llm`, ...). Each one arrives with
  its own ticket (NS-104 to NS-107).
- Docker Compose (NS-104), Zod, Drizzle, Next.js, Temporal, Playwright, the typed config module.
- ESLint or Prettier (ADR-0011 chose Biome only).
- Remote Turborepo caching.

## Open questions
1. **pnpm 10 vs current.** ADR-0011 (accepted) says pnpm 10. pnpm 11 is current (11.29.0), and
   Paul's machine has pnpm 12.4.2 installed globally. Plan: pin `pnpm@10.34.9`, the newest 10.x
   that is at least 14 days old, and let Corepack select it. Moving to 11 needs an ADR-0011
   amendment via `/adr`.
2. **Node 24 locally.** Paul's machine runs Node v22.23.2. He needs to install Node 24
   (`nvm install 24`, or `nvm use` once `.nvmrc` lands). The sandbox can't do that.
3. **Is there a package at all?** With no package, `turbo typecheck/test` have nothing to run, so
   the CI step proves only install and Biome. Options: (A) an empty `packages/domain` shell
   (package.json, tsconfig, `src/index.ts`) that NS-105 fills, or (B) root config only, with turbo
   steps that run zero packages until NS-105. Recommendation: A, to prove the whole pipeline.
   It's inferred, though: AGENTS.md says not to create folders early.
4. **TypeScript 7.** The newest release at least 14 days old is `typescript@7.0.2`, the native
   (Go) compiler. Vitest doesn't need `tsc`, and `tsc --noEmit` works the same way for typecheck.
   I haven't confirmed that 7.x is fine for the later Next.js and Drizzle tickets.

---
name: verify
description: Run Northstar's checks (format, lint, typecheck, tests, and evals for touched LLM routes) in each package the current change touches, and report the summary lines. Use before saying a task is done and before every commit.
allowed-tools: Bash(pnpm -r lint *) Bash(pnpm -r typecheck *) Bash(pnpm -r test *) Bash(pnpm --filter *) Bash(docker compose ps *) Bash(git status *) Bash(git diff *)
---

# Verify

Changed files:

!`git status --short`

1. Decide what changed. Docs, specs or `.claude/` only: say "no code checks apply", list what you
   reviewed by hand, and stop. **Before the scaffold ticket lands there is no `package.json`:**
   say so and stop; don't invent checks.
2. Map files to packages (`apps/*`, `packages/*`). A change in a shared package (`domain`, `db`,
   `llm`, `prompts`, `ui`) means its dependents too: use `pnpm --filter <pkg>...` for dependents.
3. If tests need services, check `docker compose ps` first. Postgres or Temporal down means tests
   skip; ask Paul to start them. A skip is not a pass.
4. Run, one command per call, stopping at the first failure:

   ```bash
   pnpm --filter <pkg> lint
   pnpm --filter <pkg> typecheck
   pnpm --filter <pkg> test
   ```

5. If a prompt, model setting or agent changed, run that route's eval
   (`pnpm --filter evals eval <route>` once it exists) and compare with the committed baseline.
6. Report one line per check with the tool's own summary, copied, not paraphrased:

   ```text
   worker   lint:      0 problems
   worker   typecheck: 0 errors
   worker   test:      12 passed (1.9s)
   evals    scorer:    41/45 pass (baseline 40/45)
   ```

7. Anything failing or skipped: show the first error and stop. Don't fix it inside this skill and
   don't call the work done.

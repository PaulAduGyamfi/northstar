# NS-101: Repository guardrails (CI, branch protection, commit checks, license, data guards)

Status: approved by Paul (2026-11-24, gap review answers 2–9)
Requirements: NFR-SEC-001, NFR-SEC-005, NFR-AIQ-001, NFR-OPS-001; AGENTS.md "Git and pull requests"
Rules that apply: ADR-0011, ADR-0008 (CI as the first check surface), `.claude/rules/tests.md`

## Why
The rules in AGENTS.md (never commit on main, Paul merges, no secrets or personal data in a
public repo) were only words. This ticket makes GitHub and git enforce them, so any agent working
here is held to them automatically.

## Behavior
- Every commit runs gitleaks, a private-key check, a large-file check, a personal-data guard and
  (when `.claude/hooks/` changes) the hook self-tests.
- Every PR runs the same checks in CI (`checks`) plus a Claude review (`claude-review`).
- `main` is protected: PR required, `checks` must pass, no force-push or deletion.
- Dependabot bumps GitHub Actions weekly with a 14-day cooldown.
- The repo carries an Apache-2.0 `LICENSE`.
- `.gitignore` keeps `data/`, `private/`, inbox exports, vault keys and OAuth files out of git.

## Acceptance criteria
- [ ] `pre-commit run --all-files` passes locally.
- [ ] `bash .claude/hooks/test-hooks.sh` prints `all hook tests passed`.
- [ ] Committing a file containing a real-looking email or `ghp_...` token is rejected.
- [ ] The PR shows `checks` green; `claude-review` runs once `ANTHROPIC_API_KEY` is added (Paul).
- [ ] `gh api repos/PaulAduGyamfi/northstar/branches/main/protection` shows required PR review
      and the `checks` status check.
- [ ] `LICENSE` is the official Apache-2.0 text.

## Remaining steps (run from WSL: `cd ~/projects/northstar && claude`)
The files are written. The desktop session that wrote them couldn't run commands, because the
strict sandbox from `.claude/settings.json` has no Windows backend. In WSL:

1. `git switch -c ns-101`
2. Fetch the license text: `gh api /licenses/apache-2.0 --jq .body > LICENSE`, then replace
   `[yyyy]` with `2026` and `[name of copyright owner]` with `Paul Adu-Gyamfi`.
3. `chmod +x scripts/check-personal-data.sh`, then `pre-commit install` and
   `pre-commit run --all-files`. Fix what it reports. `pre-commit autoupdate` may be needed if a
   pinned `rev` is unavailable; respect the 14-day cooldown.
4. `bash .claude/hooks/test-hooks.sh`
5. Commit in two commits: `NS-101: repo guardrails ...` and
   `NS-102: account-wall and email verification requirements (ADR-0010)`.
6. `git push -u origin ns-101`, then `gh pr create` from the PR template.
7. After `checks` has run once, protect `main`:
   `gh api -X PUT repos/PaulAduGyamfi/northstar/branches/main/protection --input .github/branch-protection.json`
8. Create the backlog issues from `docs/backlog.md` (labels and milestones first).
9. Paul adds the `ANTHROPIC_API_KEY` repository secret and merges.

## Out of scope
The pnpm scaffold, Biome and Vitest config (NS-103 in the backlog).

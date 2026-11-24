#!/usr/bin/env bash
# PreToolUse hook used only by the reviewer subagents (their frontmatter registers it).
# A reviewer may look and run the checks, never change anything: each command must start with
# one of the allowed prefixes below and contain no shell operators, redirects or substitutions.
# Adapted from countersign/.claude/hooks/readonly-bash.sh (Paul's own repo).
set -euo pipefail

input=$(cat)
cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' <<<"$input")
[[ -z "$cmd" ]] && exit 0

deny() {
  echo "Blocked by .claude/hooks/readonly-bash.sh: reviewers are read-only. $1" >&2
  exit 2
}

rest="$cmd"

# Anything that chains, redirects or substitutes could hide a write.
# shellcheck disable=SC2016 # the single-quoted '$(' is the literal text we look for
case "$rest" in
  *';'* | *'&'* | *'|'* | *'>'* | *'<'* | *'`'* | *'$('* | *$'\n'*)
    deny "Run one plain command at a time, without ; & | > < or \$( )." ;;
esac

allowed=(
  "git diff" "git log" "git show" "git status" "git blame" "git ls-files" "git merge-base"
  "git rev-parse" "git branch --show-current" "git grep"
  "pnpm -r test" "pnpm -r lint" "pnpm -r typecheck" "pnpm test" "pnpm lint" "pnpm typecheck"
  "pnpm --filter"   # checked below: only test, lint and typecheck scripts
  "ls" "wc"
  "gh pr view" # the plan and tasks live in the pull request's description, not the repo
)
for prefix in "${allowed[@]}"; do
  if [[ "$rest" == "$prefix" || "$rest" == "$prefix "* ]]; then
    # These flags would write files: formatter and linter fixes, git's --output=<file>.
    [[ "$rest" == *"--fix"* || "$rest" == *"--write"* ]] && deny "--fix / --write edits files."
    [[ "$rest" == *"--output"* && "$rest" != *"--output-format"* ]] && deny "--output writes a file."
    if [[ "$prefix" == "pnpm --filter" && ! "$rest" =~ ^pnpm[[:space:]]+--filter[[:space:]]+[^[:space:]]+[[:space:]]+(test|lint|typecheck)([[:space:]]|$) ]]; then
      deny "with --filter, only the test, lint and typecheck scripts."
    fi
    exit 0
  fi
done

deny "'$rest' is not on the reviewer's list (git diff/log/show/status, pnpm test/lint/typecheck, gh pr view)."

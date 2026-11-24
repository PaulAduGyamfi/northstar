#!/usr/bin/env bash
# PostToolUse hook for Edit|Write: after an agent changes a TypeScript/JavaScript/CSS/JSON file,
# run the repo's own locked formatter and safe lint fixes on that one file. Whatever can't be
# fixed goes back to the agent as context. It never blocks: the edit already happened, and an
# unused import mid-change is normal.
# Until the scaffold ticket installs a formatter, it does nothing.
# Adapted from countersign/.claude/hooks/format-python.sh (Paul's own repo).
set -euo pipefail

input=$(cat)
file_path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' <<<"$input")
[[ -f "$file_path" ]] || exit 0
case "$file_path" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.css | *.json | *.jsonc) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  */pnpm-lock.yaml | */node_modules/* | */dist/* | */.next/*) exit 0 ;;
esac

project="${CLAUDE_PROJECT_DIR:-$PWD}"
bin="$project/node_modules/.bin"
cd "$project"   # formatters read their config from the repo root

problems=""
if [[ -x "$bin/biome" ]]; then
  # Biome formats and applies safe fixes in one pass; unsafe fixes are left to the agent.
  "$bin/biome" check --write --no-errors-on-unmatched -- "$file_path" >/dev/null 2>&1 || true
  problems=$("$bin/biome" check --no-errors-on-unmatched --reporter=summary -- "$file_path" 2>&1 | grep -vE '^(Checked|$)' || true)
elif [[ -x "$bin/prettier" ]]; then
  "$bin/prettier" --write --log-level warn -- "$file_path" >/dev/null 2>&1 || true
  if [[ -x "$bin/eslint" && "$file_path" =~ \.(ts|tsx|js|jsx|mjs|cjs)$ ]]; then
    "$bin/eslint" --fix --quiet -- "$file_path" >/dev/null 2>&1 || true
    problems=$("$bin/eslint" --quiet --format unix -- "$file_path" 2>&1 || true)
  fi
else
  exit 0   # no formatter installed yet (pre-scaffold); nothing to run
fi

if [[ -n "$problems" ]]; then
  python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "The linter still reports (fix before you call the task done; an unused import is fine mid-change):\n" + sys.argv[1]}}))' "$problems"
fi
exit 0

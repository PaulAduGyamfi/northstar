#!/usr/bin/env bash
# PreToolUse hook for Edit|Write: guards the files an agent must never change, and asks Paul
# before it changes the harness, CI, accepted decisions, eval sets, or starts a new top-level area.
#   exit 2 + stderr   -> the edit is blocked and the agent reads the reason
#   JSON "ask"        -> Paul gets a permission prompt with the reason (even in auto mode)
#   exit 0, no output -> no opinion; the normal permission rules apply
# Adapted from countersign/.claude/hooks/protect-files.sh (Paul's own repo).
set -euo pipefail

input=$(cat)
# python3 ships with Ubuntu, so no jq dependency.
file_path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' <<<"$input")
[[ -z "$file_path" ]] && exit 0

project="${CLAUDE_PROJECT_DIR:-$PWD}"
file_path="${file_path//\\//}"   # Windows separators, so the patterns below still match
rel="${file_path#"$project"/}"   # path inside the repo (unchanged if outside it)
name="${file_path##*/}"

block() {
  echo "Blocked by .claude/hooks/protect-files.sh: $1" >&2
  exit 2
}

ask() {
  python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": sys.argv[1]}}))' "$1"
  exit 0
}

# 1. Secrets. .env.example is the committed template and stays editable.
case "$name" in
  .env.example) ;;
  .env | .env.*) block "$rel holds secrets. Add new settings to .env.example with a placeholder; Paul edits .env himself." ;;
  *.pem | *.key | id_rsa | id_ed25519 | credentials.json | token.json | client_secret*.json)
    block "$rel looks like a key or OAuth credential. Credentials never live in the repo (it is public)." ;;
esac

# 2. Files that only a tool may write.
case "$name" in
  pnpm-lock.yaml | package-lock.json | yarn.lock) block "$rel is generated. Change dependencies with pnpm add, after Paul agrees." ;;
esac
case "$rel" in
  .git/*) block "$rel is git's own state." ;;
esac

# 3. Things that change how every future change is checked: allowed, but only with Paul watching.
case "$rel" in
  .claude/settings.json | .claude/settings.local.json | .claude/hooks/* | .claude/agents/* | .claude/skills/*)
    # Skills too: a skill's allowed-tools line grants permissions while it runs.
    ask "This edit changes the agent harness ($rel). Approve only if you asked for it." ;;
  .github/workflows/*)
    ask "This edit changes a workflow ($rel), which runs on GitHub with its secrets. Approve only if the plan says so." ;;
  lefthook.yml | .lefthook.yml | .husky/* | .pre-commit-config.yaml | Makefile)
    ask "This edit changes the commit checks ($rel). Dropping a check loosens every commit. Approve only if you asked for it." ;;
  evals/*)
    # Golden sets and thresholds are the quality bar for every LLM feature (NFR-AIQ-001).
    ask "This edit changes an eval set or threshold ($rel). Approve only if the plan says so; never to make a failing eval pass." ;;
esac

# 4. Accepted decision records are never rewritten; a new decision supersedes them (/adr).
if [[ "$rel" == docs/adr/*.md && -f "$file_path" ]] && grep -qiE '^\*\*Status:\*\*[[:space:]]*Accepted|^Status:[[:space:]]*accepted' "$file_path"; then
  ask "$rel is an accepted ADR. Write a new record that supersedes it instead, unless you are only fixing a typo or marking it superseded."
fi

# 5. A new top-level folder or file means a new area, which arrives with its own ticket.
if [[ "$rel" != "$file_path" ]]; then
  top="${rel%%/*}"
  if [[ ! -e "$project/$top" ]]; then
    ask "This creates '$top' at the repo root. New areas arrive with their ticket (AGENTS.md: Layout). Approve only if the plan says so."
  fi
fi

exit 0

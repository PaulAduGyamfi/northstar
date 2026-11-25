#!/usr/bin/env bash
# PreToolUse hook for MCP tools, ADR-0016 item 7: an allowlist for GitHub connector calls.
# Reads pass. Writes must target PaulAduGyamfi/northstar, and only: open a PR from the current
# branch, comment or reply on a PR, resolve a review thread, open an issue labelled agent-filed
# (never edit one, so the label and the "Parent: #N" line stay as filed), and rebase-merge with the
# head commit pinned to this checkout's HEAD. Any other GitHub tool, or a GitHub server under
# another name, is blocked. Fails closed: if the check itself breaks, the call is blocked.
#   exit 2 + stderr   -> the call is blocked and the agent reads the reason
#   exit 0, no output -> no opinion; the normal permission rules apply
set -uo pipefail

block() {
  echo "Blocked by .claude/hooks/guard-github.sh: $1" >&2
  exit 2
}

input=$(cat)
project="${CLAUDE_PROJECT_DIR:-$PWD}"
head_sha=$(git -C "$project" rev-parse HEAD 2>/dev/null || true)
branch=$(git -C "$project" branch --show-current 2>/dev/null || true)

# python3 ships with Ubuntu, so no jq dependency. Prints "ok", "skip" (not GitHub) or the reason.
reason=$(HEAD_SHA="$head_sha" BRANCH="$branch" python3 -c '
import json, os, re, sys
data = json.load(sys.stdin)
tool = str(data.get("tool_name", ""))
args = data.get("tool_input") or {}
if not isinstance(args, dict):
    print("tool_input is not an object."); sys.exit()

if not tool.startswith("mcp__github__"):
    # Another MCP server: only GitHub servers under a different name are refused.
    print("a GitHub server under another name is not allowed; use mcp__github__." if "github" in tool.lower() else "skip")
    sys.exit()
name = tool.removeprefix("mcp__github__")

READS = {"get_me", "get_commit", "get_file_contents", "get_label", "get_latest_release",
         "get_release_by_tag", "get_tag", "get_check_run", "get_job_logs", "get_team_members",
         "get_teams", "issue_read", "pull_request_read", "actions_get", "actions_list",
         "list_branches", "list_commits", "list_issues", "list_issue_fields", "list_issue_types",
         "list_pull_requests", "list_releases", "list_tags", "list_repository_collaborators"}
if name in READS:
    print("ok"); sys.exit()

# Every write must target this repo.
if (args.get("owner"), args.get("repo")) != ("PaulAduGyamfi", "northstar"):
    print("writes only to PaulAduGyamfi/northstar."); sys.exit()

if name in ("add_issue_comment", "add_reply_to_pull_request_comment", "resolve_review_thread"):
    print("ok"); sys.exit()

if name == "create_pull_request":
    branch = os.environ.get("BRANCH", "")
    if args.get("base") != "main" or not branch or args.get("head") != branch:
        print("open a PR only from the current branch into main.")
    else:
        print("ok")
    sys.exit()

if name == "merge_pull_request":
    sha = str(args.get("expectedHeadSha", ""))
    head = os.environ.get("HEAD_SHA", "")
    if args.get("merge_method") != "rebase" or not re.fullmatch(r"[0-9a-f]{40}", sha):
        print("merge only with merge_method rebase and expectedHeadSha set to the full head commit.")
    elif sha != head:
        print("merge only your own PR: expectedHeadSha must equal this checkout'"'"'s HEAD.")
    else:
        print("ok")
    sys.exit()

if name == "issue_write":
    labels = args.get("labels")
    body = str(args.get("body", ""))
    if args.get("method") != "create":
        print("issues are never edited, so the agent-filed label and the Parent line stay as filed.")
    elif not isinstance(labels, list) or "agent-filed" not in labels:
        print("every issue an agent opens carries the agent-filed label (ADR-0016).")
    elif not re.match(r"Parent: #\d+\s", body) and "idea" not in labels:
        print("an agent-filed issue starts with a Parent: #N line (ADR-0016).")
    else:
        print("ok")
    sys.exit()

print(f"{name} is not on the GitHub allowlist in ADR-0016 item 7.")
' <<<"$input" 2>/dev/null)

case "$reason" in
  ok | skip) exit 0 ;;
  "") block "the check could not run, so the call is refused." ;;
  *) block "$reason" ;;
esac

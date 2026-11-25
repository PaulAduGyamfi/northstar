#!/usr/bin/env bash
# PreToolUse hook for the GitHub connector (mcp__github__*), ADR-0015 item 7.
# An allowlist: reads pass; of the writes, agents may only open a PR, comment or reply on one,
# resolve a review thread, open an issue labelled agent-filed (never edit one, so the label and
# the "Parent: #N" line can't be removed later), and rebase-merge with the head commit pinned.
# Everything else is blocked.
#   exit 2 + stderr   -> the call is blocked and the agent reads the reason
#   exit 0, no output -> no opinion; the normal permission rules apply
set -euo pipefail

input=$(cat)
# python3 ships with Ubuntu, so no jq dependency. Prints "" when the call is allowed, else the reason.
reason=$(python3 -c '
import json, re, sys
data = json.load(sys.stdin)
tool = data.get("tool_name", "")
args = data.get("tool_input", {}) or {}
name = tool.removeprefix("mcp__github__")

# Reads never change anything.
if name.startswith(("get_", "list_", "search_")) or name in (
    "issue_read", "pull_request_read", "actions_get", "actions_list"):
    print(""); sys.exit()

# Writes on the agent'"'"'s own PR.
if name in ("create_pull_request", "add_issue_comment",
            "add_reply_to_pull_request_comment", "resolve_review_thread"):
    print(""); sys.exit()

if name == "merge_pull_request":
    sha = str(args.get("expectedHeadSha", ""))
    if args.get("merge_method") != "rebase" or not re.fullmatch(r"[0-9a-f]{40}", sha):
        print("merge only with merge_method rebase and expectedHeadSha set to the full head commit, once checks are green.")
    else:
        print("")
    sys.exit()

if name == "issue_write":
    labels = args.get("labels") or []
    body = str(args.get("body", ""))
    if args.get("method") != "create":
        print("issues are never edited, so the agent-filed label and the Parent line stay as filed. Open a new issue instead.")
    elif "agent-filed" not in labels:
        print("every issue an agent opens carries the agent-filed label (ADR-0015).")
    elif not body.startswith("Parent: #") and "idea" not in labels:
        print("an agent-filed issue starts with a Parent: #N line that leads back to an issue Paul created (ADR-0015).")
    else:
        print("")
    sys.exit()

print(f"{name} is not on the GitHub allowlist in ADR-0015 item 7.")
' <<<"$input")

if [[ -n "$reason" ]]; then
  echo "Blocked by .claude/hooks/guard-github.sh: $reason" >&2
  exit 2
fi
exit 0

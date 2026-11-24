#!/usr/bin/env bash
# PreToolUse hook for Bash: blocks commands that destroy work or data, rewrite shared history,
# skip the commit checks, or expose secrets. The deny rules in settings.json catch the usual
# spellings; this catches common variants (flags in another order, a +refspec, cat .env).
# It is a seatbelt, not a sandbox: a determined script can get around any text check, so Paul
# still reviews the plan.
# Adapted from countersign/.claude/hooks/guard-bash.sh (Paul's own repo).
set -euo pipefail

input=$(cat)
cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' <<<"$input")
[[ -z "$cmd" ]] && exit 0

block() {
  echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2
  echo "If this is really needed, stop and ask Paul to run it himself." >&2
  exit 2
}

# Word boundary for the start of a command: line start, whitespace or a shell operator.
s='(^|[[:space:];&|(`])'

# Deleting trees: rm with both a recursive and a force flag, in any order or spelling.
# Only the rm command's own words count (up to the next ; & | operator).
if [[ "$cmd" =~ ${s}rm[[:space:]]+([^;&|]*) ]]; then
  flags=$(grep -oE '(^|[[:space:]])-[A-Za-z]+|--(recursive|force)' <<<"${BASH_REMATCH[2]}" | tr -d ' \n' || true)
  if [[ "$flags" =~ [rR] || "$flags" == *recursive* ]] && [[ "$flags" =~ f || "$flags" == *force* ]]; then
    block "recursive forced delete (rm -rf). Delete specific files by name instead."
  fi
fi

# Git: shared history and uncommitted work.
[[ "$cmd" =~ ${s}git[[:space:]].*push.*(--force|--force-with-lease|[[:space:]]-[A-Za-z]*f) ]] && block "force push."
[[ "$cmd" =~ ${s}git[[:space:]].*push.*[[:space:]]\+[A-Za-z0-9_./-]+ ]] && block "force push via a +refspec."
[[ "$cmd" =~ ${s}git[[:space:]].*reset[[:space:]].*--hard ]] && block "git reset --hard throws away uncommitted work."
[[ "$cmd" =~ ${s}git[[:space:]].*clean[[:space:]].*-[A-Za-z]*f ]] && block "git clean -f deletes untracked files."
[[ "$cmd" =~ ${s}git[[:space:]].*push.*--no-verify ]] && block "--no-verify skips the checks."
[[ "$cmd" =~ ${s}git[[:space:]].*branch[[:space:]].*-D[[:space:]]+main ]] && block "deleting main."

# Git hooks: every way to commit without the commit checks.
# A commit's own words, up to the next ; & | operator: -n alone or in a group (-an), or
# --no-verify, which git also accepts shortened (--no-veri).
commit_skips_hooks() {
  [[ "$1" =~ ${s}git[[:space:]]([^;&|]*[[:space:]])?commit([[:space:]][^;&|]*)?($|[;&|]) ]] &&
    [[ "${BASH_REMATCH[3]} " =~ [[:space:]](-[A-Za-z]*n[A-Za-z]*|--no-veri[a-z]*)[[:space:]] ]]
}
# Check the command with its quoted text dropped (so a message that mentions -n is no flag),
# then each quoted piece on its own (so bash -c 'git commit -n' is still seen).
unquoted=$(sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g" <<<"$cmd")
while IFS= read -r piece; do
  commit_skips_hooks "$piece" && block "git commit -n / --no-verify skips the commit checks."
done < <(printf '%s\n' "$unquoted"; grep -oE "'[^']*'|\"[^\"]*\"" <<<"$cmd" | tr -d "'\"" || true)
lower="${cmd,,}"
[[ "$lower" == *core.hookspath* ]] && block "core.hooksPath points git away from the hooks."
[[ "$cmd" =~ (^|[^A-Za-z0-9_])SKIP= ]] && block "SKIP= turns commit hooks off."
[[ "$cmd" =~ (^|[^A-Za-z0-9_])LEFTHOOK=0 ]] && block "LEFTHOOK=0 turns commit hooks off."
[[ "$cmd" =~ (^|[^A-Za-z0-9_])HUSKY=0 ]] && block "HUSKY=0 turns commit hooks off."

# Paul's data and machine.
[[ "$cmd" =~ ${s}docker[[:space:]]+compose[[:space:]].*down.*(-v|--volumes) ]] && block "docker compose down -v deletes the database volume."
[[ "$cmd" =~ ${s}docker[[:space:]]+volume[[:space:]]+(rm|prune) ]] && block "removing docker volumes deletes data."
[[ "$lower" =~ drop[[:space:]]+(database|schema) ]] && block "DROP DATABASE/SCHEMA. Only the test setup wipes, and only *_test databases."
[[ "$cmd" =~ ${s}sudo[[:space:]] ]] && block "sudo. Nothing in this repo needs root."
[[ "$cmd" =~ (curl|wget)[^|]*\|[[:space:]]*(ba|z)?sh ]] && block "piping a download into a shell."

# Secrets: the .env file (the .env.example template is fine) and the whole environment.
if [[ "$cmd" =~ (^|[^A-Za-z0-9_.-])\.env($|[^A-Za-z0-9_.-]|\.[A-Za-z0-9_-]+) ]]; then
  stripped="${cmd//.env.example/}"
  if [[ "$stripped" =~ (^|[^A-Za-z0-9_.-])\.env($|[^A-Za-z0-9_-]) ]]; then
    block "the command touches .env, which holds Paul's secrets."
  fi
fi
[[ "$cmd" =~ ${s}printenv([[:space:]]|$) ]] && block "printenv can show secrets."
bare_env="${s}env[[:space:]]*(\$|[;&|)])"   # in a variable: [[ can't parse ) inside [...]
[[ "$cmd" =~ $bare_env ]] && block "printing the whole environment can show secrets."
[[ "$cmd" =~ \$\{?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD) ]] && block "the command expands a variable that holds a secret."
[[ "$cmd" =~ (\.aws/|\.ssh/|\.config/gh/|\.config/gcloud/) ]] && block "the command reads credentials from your home directory."
[[ "$cmd" =~ ${s}gh[[:space:]]+auth[[:space:]]+token ]] && block "gh auth token prints Paul's GitHub token."

# This repo is public: changing visibility or deleting it is Paul's call.
[[ "$cmd" =~ ${s}gh[[:space:]]+repo[[:space:]]+(delete|edit) ]] && block "changing the GitHub repo's settings is Paul's call."

# Merging is Paul's job.
[[ "$cmd" =~ ${s}gh[[:space:]]+pr[[:space:]]+merge ]] && block "Paul merges pull requests."

exit 0

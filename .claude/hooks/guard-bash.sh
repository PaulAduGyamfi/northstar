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

# gh and git push commands in settings.json's sandbox.excludedCommands run OUTSIDE the sandbox
# with Paul's GitHub login. Anything chained or substituted into them would run there too, so
# they may not contain shell metacharacters ($ ` ; & | < > or a newline).
# An allowlist of characters, not a blocklist: zsh also runs code through =(...), glob qualifiers
# like *(e:...:) and more, none of which need $ ` ; & | < >. Titles with ( ) go in --body-file.
unsandboxed='^[[:space:]]*(gh[[:space:]]+(pr|issue|run)|git[[:space:]]+push)([[:space:]]|$)'
plain_chars="^[A-Za-z0-9 ._/:@#,'\"+=-]*\$"
# The same command with quote and backslash characters removed, so "git" push or g\it push
# can't hide the command word.
bare="${cmd//[\'\"\\]/}"
if [[ "$cmd" =~ $unsandboxed || "$bare" =~ $unsandboxed ]]; then
  [[ "$cmd" =~ $plain_chars ]] ||
    block "commands that run with Paul's GitHub login may only use letters, digits, spaces and ._/:@#,'\"+=-"
  # --repo could post to (or read from) any repo Paul can reach. --jq and --template run gh's jq,
  # whose env builtin reads Paul's real, unsandboxed environment (tokens). Blocked in every
  # spelling: --jq=x, -qx, and inside short-flag groups (-wq, -Rowner/x).
  [[ "$cmd" =~ (^|[[:space:]])--(repo|jq|template)([[:space:]=]|$) ]] &&
    block "--repo, --jq and --template aren't allowed in gh commands that run with Paul's login."
  [[ "$cmd" =~ (^|[[:space:]])-[A-Za-z]*[qtR] ]] &&
    block "-q, -t and -R (jq, template, other repo) aren't allowed in gh commands that run with Paul's login."
  # --body-file reads any file Paul can (resume, credentials) into a public PR or issue, so it
  # may only read Claude's own temp files. Only a backstop: it misses -F/path, -dF and symlinks,
  # which is why gh pr create and gh issue create are NOT in excludedCommands (Paul runs them).
  if [[ "$cmd" =~ (^|[[:space:]])(--body-file|-F)[[:space:]=]+([^[:space:]]*) ]]; then
    body="${BASH_REMATCH[3]}"
    [[ "$body" =~ ^/tmp/claude-[0-9]+/ && "$body" != *..* ]] ||
      block "--body-file must be a file in Claude's temp directory (/tmp/claude-<uid>/...)."
  fi
fi

# Read-only gh commands are auto-allowed AND unsandboxed (no prompt, Paul's login), so each has
# one exact shape: no quotes (a quote hides a flag from any check), no URL or other repo, no jq.
readonly_gh='^[[:space:]]*gh[[:space:]]+(pr[[:space:]]+(view|checks)|run[[:space:]]+view|issue[[:space:]]+(view|list))([[:space:]]|$)'
if [[ "$bare" =~ $readonly_gh ]]; then
  ref='[A-Za-z0-9][A-Za-z0-9._-]*' # a PR number or branch name; no : or / so no URL
  fields='[A-Za-z,]+'
  shapes=(
    "^gh pr view( $ref)?( --json $fields)?\$"
    "^gh pr checks( $ref)?( --watch)?( --interval [0-9]+)?\$"
    "^gh run view [0-9]+( --json $fields| --log| --log-failed)?\$"
    "^gh issue view [0-9]+( --json $fields)?\$"
    "^gh issue list( --state (open|closed|all))?( --limit [0-9]+)?( --label [a-z0-9:-]+)*( --json $fields)?\$"
  )
  shape_ok=no
  for re in "${shapes[@]}"; do [[ "$cmd" =~ $re ]] && shape_ok=yes; done
  [[ $shape_ok == yes ]] || block "read-only gh commands must use their plain shape (see AGENTS.md), no quotes, URLs, -q/--jq or -R."
fi

# Pushing: one shape only, `git push [-u|--set-upstream] origin <branch>`, never main or HEAD.
# An allowlist, because a blocklist misses --mirror, --delete, :branch, --receive-pack, URLs.
# Detected on the command with quoted text removed, so a commit message that says "push" is fine.
if [[ "$unquoted" =~ ${s}git([[:space:]]+-[^[:space:]]+)*[[:space:]]+push([[:space:]]|$) ||
  "$bare" =~ ^[[:space:]]*git([[:space:]]+-[^[:space:]]+)*[[:space:]]+push([[:space:]]|$) ]]; then
  push_shape='^git push( -u| --set-upstream)? origin ([A-Za-z0-9][A-Za-z0-9._-]*)$'
  [[ "$cmd" =~ $push_shape ]] || block "push only with: git push [-u] origin <branch>."
  [[ "${BASH_REMATCH[2]}" == main || "${BASH_REMATCH[2]}" == HEAD ]] && block "pushing main is done through a PR."
fi

# Merging: agents may merge, and settings.json's "ask" rule prompts Paul for each one.
# One shape only: --rebase (the repo forbids merge commits; a squash folds a ticket's commits into
# one), --match-head-commit (merges exactly the commit Paul approved), and nothing else, so no
# --admin (would bypass branch protection if enforce_admins were ever off) and no --auto
# (would merge later pushes without a new prompt).
if [[ "$unquoted" =~ ${s}gh([[:space:]]+-[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge ||
  "$bare" =~ ^[[:space:]]*gh([[:space:]]+-[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge ]]; then
  merge_shape='^gh pr merge [0-9]+ --rebase( --delete-branch)? --match-head-commit [0-9a-f]{40}$'
  [[ "$cmd" =~ $merge_shape ]] || block "merge only with: gh pr merge <n> --rebase [--delete-branch] --match-head-commit <sha>."
fi

# Docker (NS-109). `docker compose -f docker-compose.yml up -d|ps|exec` run OUTSIDE the sandbox
# (settings.json excludedCommands) against the Docker daemon, which is root-equivalent on Paul's
# machine. So every command that runs docker must be one exact shape. An allowlist, because a
# blocklist misses the many ways to point compose elsewhere (-f, -p, --project-directory, -H,
# --context, COMPOSE_FILE= or DOCKER_HOST= prefixes, --build, chaining). Anything else: Paul runs it.
#
# Detection splits the command into shell words (python shlex undoes quotes and backslashes, so
# "docker", \docker and d\ocker are all docker) and looks for docker where a command starts: at
# the beginning, after ; & | ( or a newline, after VAR=value prefixes and wrappers (command, env,
# timeout, ...), inside `sh -c '...'` / eval, and inside $(...) or backticks. Unbalanced quotes
# fail closed. The word docker anywhere else (a commit message, `grep docker`) is just a word.
runs=$(python3 - "$cmd" <<'PY'
import re, shlex, sys

WRAPPERS = {"command", "builtin", "exec", "env", "time", "nohup", "nice", "ionice", "timeout",
            "stdbuf", "xargs", "sudo", "doas", "then", "do", "else", "elif", "if", "while",
            "until", "!", "{", "function"}
REDIRECT = re.compile(r"^[0-9]*[<>&]")  # >/dev/null, 2>&1, </dev/null in front of a command
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
WRAPPER_ARG = re.compile(r"^(-.*|[0-9.]+[smhd]?)$")  # timeout 5s, nice -n 10, env -i
OPERATOR = set(";&|()\n")
ALL = {"docker", "gh", "push"}
# NS-132: options before git's or gh's subcommand that take the next word as their value.
GIT_ARG_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
                "--attr-source", "--super-prefix", "--config-env", "--list-cmds"}
GH_ARG_OPTS = {"-R", "--repo", "--hostname"}
GH_UNSANDBOXED = {"pr", "issue", "run"}

def words(text):
    lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    return list(lex)

def mentions(text):
    """Unsplittable text: every guarded word it contains, quotes and backslashes removed."""
    plain = re.sub(r"[\"'\\]", "", text)
    found = set()
    if "docker" in plain:
        found.add("docker")
    if re.search(r"\bgh\b", plain):
        found.add("gh")
    if re.search(r"\bpush\b", plain):
        found.add("push")
    return found

def subcommand(rest, arg_opts):
    """The first word after a program's leading options: git -C dir push gives push."""
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok and set(tok) <= OPERATOR:
            return None
        if tok in arg_opts:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return tok
    return None

def kinds_at(name, rest):
    """Which guarded commands a program name in command position runs, given its words."""
    found = set()
    if name == "docker":
        found.add("docker")
    if name == "gh" and subcommand(rest, GH_ARG_OPTS) in GH_UNSANDBOXED:
        found.add("gh")
    if name == "git" and subcommand(rest, GIT_ARG_OPTS) == "push":
        found.add("push")
    return found

HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

def split_heredocs(text):
    """Returns (shell text without heredoc bodies, bodies fed to a shell).
    A heredoc body is data for its command (python3 - <<EOF ... EOF), not shell commands, unless
    that command is itself a shell (bash <<EOF), whose body is commands and gets scanned."""
    lines, out, shell_bodies, i = text.split("\n"), [], [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in HEREDOC.finditer(line):
            tag, body = m.group(2), []
            while i < len(lines) and lines[i].strip() != tag:
                body.append(lines[i])
                i += 1
            i += 1  # the terminator line
            first = line[: m.start()].split()
            if first and first[0].rsplit("/", 1)[-1] in SHELLS:
                shell_bodies.append("\n".join(body))
    return "\n".join(out), shell_bodies

def runs(text, depth=0):
    """Which of docker, gh pr|issue|run and git push the text runs as a command."""
    if depth > 4:
        return set(ALL)
    found = set()
    text, shell_bodies = split_heredocs(text)
    for body in shell_bodies:
        found |= runs(body, depth + 1)
    # A newline separates commands like ; does (inside a quoted string it changes nothing).
    text = text.replace("\n", " ; ")
    # $(...) and unescaped `...` run their contents as commands, wherever they sit.
    for inner in re.findall(r"\$\(([^()]*)\)|(?<!\\)`([^`]*?)(?<!\\)`", text):
        found |= runs(inner[0] or inner[1], depth + 1)
    try:
        toks = words(text)
    except ValueError:
        # Unbalanced quotes: can't split it, so fail closed whenever a guarded word appears.
        return found | mentions(text)
    # Backstop: the guarded words side by side, anywhere (docker compose, gh pr|issue|run, git
    # push). Catches what the command-start walk below can miss (a redirection or `function` in
    # front, a wrapper flag that takes an argument). A commit message is one quoted word, so it
    # doesn't trip this.
    for i in range(len(toks) - 1):
        name, nxt = toks[i].rsplit("/", 1)[-1], toks[i + 1]
        if name == "docker" and nxt == "compose":
            found.add("docker")
        if name == "gh" and nxt in GH_UNSANDBOXED:
            found.add("gh")
        if name == "git" and nxt == "push":
            found.add("push")
    at_start, after_wrapper = True, False
    for i, tok in enumerate(toks):
        if tok and set(tok) <= OPERATOR:
            at_start, after_wrapper = True, False
            continue
        if not at_start:
            continue
        if ASSIGN.match(tok) or REDIRECT.match(tok):
            continue
        if tok in WRAPPERS:
            after_wrapper = True
            continue
        if after_wrapper and WRAPPER_ARG.match(tok):
            continue
        # A program name built at run time ($d, $(printf docker), $'\x64ocker', dock*) could be
        # any of them: only a plain literal file name counts as "not guarded". A variable in the
        # folder part ($TMPDIR/run.sh) is fine.
        name = tok.rsplit("/", 1)[-1]
        # [ and [[ are the test command, not a glob.
        if name not in ("[", "[[") and (re.search(r"[$`*?\[]", name) or tok.startswith(("$(", "$'"))):
            return set(ALL)
        found |= kinds_at(name, toks[i + 1:])
        if name in SHELLS or name == "eval":
            rest = toks[i + 1:]
            script = rest[rest.index("-c") + 1] if "-c" in rest[:-1] else " ".join(rest)
            if name == "eval" or "-c" in rest[:-1]:
                found |= runs(script, depth + 1)
        at_start, after_wrapper = False, False
    return found

print(" ".join(sorted(runs(sys.argv[1]))))
PY
)

# NS-132: gh pr|issue|run and git push run OUTSIDE the sandbox with Paul's GitHub login, and the
# text checks above only see them at the start of the command. When the tokenizer finds one in
# command position anywhere (after a VAR= prefix or a wrapper, after ; && |, inside sh -c, eval
# or $(...), spelled "gh", \gh or g\it), the command must be that plain command and nothing
# else, so every shape check above has applied to it.
if [[ " $runs " == *" gh "* || " $runs " == *" push "* ]]; then
  [[ "$cmd" =~ ^(gh[[:space:]]+(pr|issue|run)|git[[:space:]]+push)([[:space:]]|$) ]] ||
    block "gh pr|issue|run and git push must be the whole command, spelled plainly: no prefix, wrapper, quotes, escapes, chaining or substitution."
fi

if [[ " $runs " == *" docker "* ]]; then
  svc='[a-z0-9][a-z0-9-]*'
  # -f docker-compose.yml is pinned: with an explicit file, compose doesn't auto-load
  # compose.yaml or *.override.* files the sandboxed shell might create, and ignores COMPOSE_FILE.
  pin='docker compose -f docker-compose.yml'
  up_shape="^$pin up -d( --wait)?( $svc)*\$"
  ps_shape="^$pin ps( --all)?( --format (json|table))?( $svc)?\$"
  # exec still asks Paul (settings.json). Its words reach a shell inside the container, so only
  # plain characters: nothing the host shell would expand or chain.
  exec_shape="^$pin exec( -T)? $svc [A-Za-z0-9 ._/:@,'\"+=-]+\$"
  # Sandboxed (not in excludedCommands): CI's compose validation with the committed template.
  config_shape='^docker compose( -f docker-compose\.yml)?( --env-file \.env\.example)? config( --quiet)?$'
  if [[ "$cmd" =~ $up_shape || "$cmd" =~ $ps_shape || "$cmd" =~ $exec_shape ]]; then
    # exec output lands in the chat: never let it print a process environment (secrets from .env).
    # Checked with quotes removed (envi''ron). Best effort: Paul's exec prompt is the real control.
    [[ "$bare" =~ environ ||
      "$bare" =~ [[:space:]](set|export|declare|env|printenv)([[:space:]]|$) ]] &&
      block "docker compose exec may not print a process environment (/proc/*/environ, set, export, declare, env, printenv): it holds secrets from .env."
    # These run unsandboxed. Compose resolves -f docker-compose.yml and reads .env relative to the
    # working directory, so they may only run from the project root, with both files plain files
    # (not links), and a .env that sets no COMPOSE_ variable (COMPOSE_PROFILES, COMPOSE_PROJECT_NAME
    # and the like change what compose runs). Fail closed when anything is unknown.
    project="${CLAUDE_PROJECT_DIR:-}"
    [[ -n "$project" ]] || block "unknown project directory, so docker compose can't be checked."
    cwd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' <<<"$input")
    [[ -n "$cwd" && "$(realpath -e -- "$cwd" 2>/dev/null)" == "$(realpath -e -- "$project" 2>/dev/null)" ]] ||
      block "docker compose runs only from the project root ($project). cd there first."
    for f in docker-compose.yml .env; do
      [[ -f "$project/$f" && ! -L "$project/$f" ]] || block "$f must be a plain file in the project root (not missing, not a link)."
    done
    # A hard link planted while .env was missing could be changed after this check.
    [[ "$(stat -c %h -- "$project/.env")" == 1 ]] || block ".env has more than one hard link. Ask Paul."
    # grep -q prints nothing, so no value from .env leaves this hook.
    grep -qE '^[[:space:]]*(export[[:space:]]+)?COMPOSE_' "$project/.env" &&
      block "the project .env sets a COMPOSE_ variable, which changes what docker compose runs. Ask Paul."
  elif [[ ! "$cmd" =~ $config_shape ]]; then
    block "docker only with: $pin up -d [--wait] [service...], $pin ps [--all] [--format json|table] [service], $pin exec [-T] <service> <plain words>, or docker compose [--env-file .env.example] config [--quiet]. Run from the project root. Ask Paul to run anything else."
  fi
fi

exit 0

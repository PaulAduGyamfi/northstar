# NS-109: Protect compose files and unsandboxed docker commands in the harness

Status: approved by Paul (2026-11-24; denyWrite for the existing file, guard-bash filesystem check for new ones, allowRead for the template)
Requirements: AGENTS.md (harness guardrails, "never bypass a hook"), the NS-104 security review,
CLAUDE.md ("Hooks are guardrails"). GitHub issue #33.
Rules that apply: AGENTS.md (Never: edit the harness to get past a check), CLAUDE.md, ADR-0011.

## Why
`docker compose up -d *`, `ps *` and `exec *` run **outside the sandbox**, and `up` and `ps` run
without a prompt. Since NS-104 the repo has a `docker-compose.yml`, and nothing protects it. An
agent could edit it, from the editor or from the sandboxed shell, to add a host bind mount,
`privileged`, host pid or network, `build:` or `include:`, and then start it with no prompt. The
Docker daemon is root-equivalent on Paul's machine. After this ticket, changing a compose file
needs Paul's yes. The unsandboxed docker commands also get the same one-exact-shape rule the gh
and git push commands already have.

## Behavior
**protect-files.sh** (Edit/Write): asks Paul ("This edit changes the local stack (…), which runs
outside the sandbox …") before any edit to a file named `docker-compose.yml`,
`docker-compose.yaml`, `compose.yml`, `compose.yaml`, `*.override.yml` or `*.override.yaml`, in
any folder. Compose auto-loads `compose.yaml` and `*.override.*` files next to the main one, so
creating a new one counts too.

**settings.json sandbox**: `sandbox.filesystem.denyWrite: ["./docker-compose.yml", "./.env"]`, so
`sed`, `cat >` or a script in the sandboxed shell can't change the compose file or the project
`.env` (which compose reads `COMPOSE_*` settings from) around the hook. Per the Claude Code docs,
on Linux `denyWrite` takes no wildcards except a trailing `/**`, and an entry for a path that
doesn't exist yet has no effect. That is why the shapes below pin `-f docker-compose.yml`, and why
guard-bash checks `.env` itself.

**settings.json excluded and allowed commands** become the pinned forms:
`docker compose -f docker-compose.yml up -d *` and `… ps *` (unsandboxed, auto-allowed), and
`… exec *` (unsandboxed, asks).

**guard-bash.sh** (revised after the NS-109 reviews): an allowlist. Every command that *runs*
docker must be exactly one of these shapes, and anything else is blocked ("Ask Paul to run
anything else"), including `docker version`, `docker compose logs` and `docker compose down`:
- `docker compose -f docker-compose.yml up -d [--wait] [service ...]`
- `docker compose -f docker-compose.yml ps [--all] [--format json|table] [service]`
- `docker compose -f docker-compose.yml exec [-T] <service> <words ...>`. This one still asks
  Paul. Its words may only use letters, digits, spaces and `._/:@,'"+=-`, so no
  `$ ; & | < > ( ) { } * ? ~ !` or newline can reach the host shell. It may not mention
  `environ`, because exec output lands in the chat.
- the sandboxed check `docker compose [-f docker-compose.yml] [--env-file .env.example] config
  [--quiet]` (CI's command).

Service names are lowercase letters, digits and `-`, never starting with `-`. With
`-f docker-compose.yml` pinned, compose doesn't auto-load `compose.yaml` or `*.override.*` files
and ignores `COMPOSE_FILE`.

How "runs docker" is detected: python `shlex` splits the command into shell words, undoing quotes
and backslashes, so `"docker"`, `\docker` and `d\ocker` are all docker. The hook then looks for
docker wherever a command starts:
- at the beginning, or after `; & | (` or a newline;
- after `VAR=value` prefixes and wrappers (`command`, `env`, `timeout 5s`, `nice -n 10`, …);
- as `/usr/bin/docker`;
- inside `sh -c '…'` or `eval`;
- inside `$(…)` or backticks.

Unbalanced quotes count as docker, and the command fails the shape check. The word docker
anywhere else (a commit message, `grep docker`, `git log --grep docker`) is just a word.

Before allowing the three unsandboxed shapes, the hook also checks the filesystem. The hook runs
outside the sandbox, so it sees the real files. It fails closed on any of these:
- `CLAUDE_PROJECT_DIR` is unset;
- the shell's working folder (from the hook input's `cwd`) isn't the project root;
- `docker-compose.yml` or `.env` is missing or is a symlink;
- `.env` sets any `COMPOSE_` variable, checked with `grep -q`, which prints nothing.

Compose resolves `-f` and `.env` against the working folder, so `cd sub && docker compose -f
docker-compose.yml up -d` would otherwise load a file the sandboxed shell wrote.

**`.env.example` readable in the sandbox** (seen in NS-104): the read-deny `.env.*` currently hides
the template too. The `!.env.example` negation works for the Read tool, but the sandbox doesn't
honor it. The documented sandbox mechanism is narrower-path precedence:
`sandbox.filesystem.allowRead: ["./.env.example"]` reopens the one file inside the denied glob.
`.env` and every other `.env.*` stay unreadable.

**test-hooks.sh**: a case for each compose file name (ask), a non-compose YAML (pass), each
allowed docker shape (pass), and each blocked spelling: `-f`, `--project-directory`, `-H`, an env
prefix, `--build`, chaining, substitution, a quoted command word and an exec with `$(…)`.

**Docs**: CLAUDE.md's hook bullet and AGENTS.md's compose line say compose edits ask Paul.

## Acceptance criteria
- [ ] `bash .claude/hooks/test-hooks.sh` prints `all hook tests passed`, including the new cases.
- [ ] Editing `docker-compose.yml` with the Edit tool shows Paul an ask prompt (shown once by
      hand in the PR).
- [ ] In the sandboxed shell, `echo x >> docker-compose.yml` fails with a permission error and the
      file is unchanged (shown once by hand).
- [ ] In the sandboxed shell, `head -1 .env.example` prints the template's first line, and
      `cat .env` still fails.
- [ ] `docker compose -f docker-compose.yml ps` (an allowed shape) still runs for Paul's stack.
      Every bypass the reviews found is a test-hooks case: hidden spellings, a subfolder `cwd`,
      `COMPOSE_` in `.env`, symlinks, `environ`, and names from expansions.
- [ ] `pre-commit run --all-files` checks pass (run directly in the sandbox) and `checks` is green.
- [ ] The security reviewer finds nothing critical.

## Failure modes
- **A hook script errors:** settings.json has `onFailure: "block"`, so a broken hook blocks the
  tool call instead of letting it through. test-hooks catches a broken hook before it merges.
- **A legitimate compose command is blocked:** the message names the allowed shapes, and Paul
  runs anything else himself with `!`.
- **The sandbox setting isn't supported as written:** the manual acceptance check (`echo >>`
  fails) catches it before merge.

## Observability
None at runtime. Each block or ask message names the rule and the file.

## Out of scope
- Moving `pnpm -r test` and `pnpm --filter * test` back inside the sandbox (also from the NS-108
  review). That's a separate harness change with its own trade-offs.
- Validating the content of compose files (no bind mounts, no `privileged`) with a linter. The
  ask prompt and Paul's review are the control.

## Open questions
1. **Sandbox write-deny (answered from the Claude Code docs).** The key is
   `sandbox.filesystem.denyWrite`. On Linux it supports no mid-path wildcards and doesn't cover
   paths that don't exist yet, so new compose files are handled by guard-bash's filesystem check
   instead. Untested in the docs: whether it applies inside the live session without a restart.
   The manual check in the acceptance criteria settles that.
2. **`--env-file` (resolved by the allowlist).** It is allowed only as `--env-file .env.example`
   in the sandboxed `config` shape (CI's command), and nowhere else.
4. **Can a sandboxed command reach the Docker daemon? (unverified)** The guard only sees command
   text, so a copy or symlink of the docker binary under another name (`./dk compose …`) is
   invisible to it. Such a command doesn't match `excludedCommands`, so it runs sandboxed. It is
   harmless only if the sandbox blocks the Docker socket. The agent's probe (connecting to
   `/var/run/docker.sock` from the sandbox) was refused by the auto-mode classifier, so Paul
   must check this. If the sandbox can reach the socket, that is a separate, bigger hole for its
   own ticket: deny the socket path in the sandbox settings.
3. **`.env.example` exception.** The docs document narrower-path precedence (`allowRead` inside a
   `denyRead`) but give no example of an exact file inside a glob, so it's tested by hand.
   Fallback if it doesn't work: replace the `.env.*` glob with an explicit list of the usual
   variants (`.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.test`,
   `.env.staging`). The protect-files and guard-bash `.env.*` checks still cover any other name.

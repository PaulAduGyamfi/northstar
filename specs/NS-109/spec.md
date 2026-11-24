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

**settings.json sandbox**: `sandbox.filesystem.denyWrite: ["./docker-compose.yml"]`, so `sed`,
`cat >` or a script in the sandboxed shell can't change the compose file around the hook. Per the
Claude Code docs, on Linux `denyWrite` takes no wildcards except a trailing `/**`, and an entry for
a path that doesn't exist yet has no effect. So it can't stop the sandboxed shell from *creating*
a `compose.yaml` or `docker-compose.override.yml`, which compose would load automatically.

**guard-bash.sh, filesystem check**: the hook runs outside the sandbox. Before it allows an
unsandboxed `docker compose up|ps|exec`, it checks the project root. It blocks if any compose file
other than `docker-compose.yml` exists there: `compose.yml`, `compose.yaml`,
`docker-compose.yaml`, or any `*.override.yml` / `*.override.yaml`. The message names the file.
That closes the "create a new file compose will load" path that `denyWrite` can't cover.

**guard-bash.sh**: the unsandboxed docker commands may only take these shapes, checked on the
command with quotes and backslashes removed, so `"docker" compose` can't hide the words:
- `docker compose up -d [--wait] [service ...]`
- `docker compose ps [--all] [--format json|table] [service]`
- `docker compose exec [-T] <service> <words ...>`. This one still asks Paul via settings.json.
  Its words may only use letters, digits, spaces and `._/:@,'"+=-`, so no `$ ; & | < > ( ) {
  } * ? ~ !` or newline can reach the host shell.

Service names are lowercase letters, digits and `-`. Global flags that point compose or docker
elsewhere are blocked in any docker command: `-f`/`--file`, `-p`/`--project-name`,
`--project-directory`, `--env-file`, `-H`/`--host`, `--context` and `--config`. So are
environment prefixes that do the same: `COMPOSE_FILE=`, `COMPOSE_PROJECT_NAME=`, `DOCKER_HOST=`,
`DOCKER_CONTEXT=`, `DOCKER_CONFIG=`. Sandboxed docker commands that aren't in the excluded list,
such as `docker compose --env-file .env.example config --quiet` (CI's check), keep working,
except the `--env-file` flag, which moves to an allowed spelling (open question 2).

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
- [ ] `docker compose ps` (an allowed shape) still runs. `docker compose -f /tmp/x.yml up -d` is
      blocked by guard-bash, shown by test-hooks.
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
2. **`--env-file` in sandboxed commands.** Blocking `--env-file` everywhere would also block CI's
   local check command. Recommended: block it only in the unsandboxed shapes, which never need
   it, and allow it in sandboxed commands. Read-denying `.env` already keeps the secrets out.
3. **`.env.example` exception.** The docs document narrower-path precedence (`allowRead` inside a
   `denyRead`) but give no example of an exact file inside a glob, so it's tested by hand.
   Fallback if it doesn't work: replace the `.env.*` glob with an explicit list of the usual
   variants (`.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.test`,
   `.env.staging`). The protect-files and guard-bash `.env.*` checks still cover any other name.

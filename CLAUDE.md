@AGENTS.md

## Claude Code

<!-- Claude-only notes. Shared rules belong in AGENTS.md, area rules in .claude/rules/. -->

- **Run Claude Code inside WSL** for this repo (`cd ~/projects/northstar && claude`). The hooks
  are bash scripts, and the strict sandbox needs Linux (`bubblewrap` and `socat`, like
  countersign). A session opened from Windows can't run any command here, by design.
- **Auto mode, Paul oversees.** Paul runs sessions in auto mode and watches rather than approving
  each step. The hooks, deny rules and `ask` prompts (pushes, PR creation, merges, dependencies,
  harness edits) are the checkpoints, so never route around them. Work ticket by ticket from the
  GitHub issues.
- **Plan first.** For a ticket, run `/ticket <id>`: it writes `specs/<id>/spec.md`, puts the plan
  and tasks in the chat, and stops for Paul's approval. Edit nothing until he approves.
- **Verify before you say done.** Run `/verify` and paste its summary lines. If you didn't run a
  check, say so. Never write "should pass".
- **Review in a fresh context.** Before proposing a commit or PR, delegate to the `reviewer`
  subagent with the spec path and the plan. Also use `security-reviewer` when the diff touches
  gateways, OAuth/secrets, settings, prompts that read untrusted text, dependencies, `.claude/`
  or `.github/`. Fix what they mark critical; list the rest for Paul.
- **Hooks are guardrails.** One formats each TypeScript file you edit once a formatter is
  installed. Another blocks edits to `.env`, lock files and git internals, and asks Paul before
  changes to the harness, workflows, accepted ADRs, eval sets or compose files. A third blocks
  destructive or secret-revealing shell commands. It allows docker only as
  `docker compose -f docker-compose.yml up -d|ps|exec …` from the repo root (those run outside
  the sandbox), plus the sandboxed `config` check. `exec` output lands in the chat, so it may
  not read process environments. When a hook blocks you, say what you were trying to do.
  Never work around it.
- **Decisions** go through `/adr <title>`.
- **Context.** Use a subagent for wide searches. After two failed attempts at the same fix, stop,
  summarize what you tried, and ask.
- **Explain for Paul.** End each task with a short walkthrough of the diff and one question he
  should be able to answer about it.

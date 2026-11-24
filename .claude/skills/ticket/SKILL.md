---
name: ticket
description: Start or continue a Northstar ticket (NS-NNN) through the spec, plan and tasks loop. Writes specs/<ticket>/spec.md from specs/TEMPLATE/ if it is missing, writes the plan and tasks in the chat (they go in the pull request description, not the repo), stops for Paul's approval, then works the tasks one at a time.
argument-hint: "[ticket-id, e.g. NS-101]"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git branch --show-current) Bash(git switch -c *)
---

# Ticket $ARGUMENTS

Repo state when this ran:

!`git status --short --branch`

Where things live: `specs/$ARGUMENTS/spec.md` is committed. The plan and the tasks are written in
the chat from `specs/TEMPLATE/plan.md` and `tasks.md` and end up in the pull request description;
they are never committed.

## 1. Find where we are

- If the current branch is `main`, propose `git switch -c` with the ticket id in lower case
  (`ns-101`) and wait for Paul to agree.
- **No `specs/$ARGUMENTS/` folder:** go to step 2 and start with the spec.
- **`spec.md` exists, plan and tasks are in this conversation:** resume at the first unchecked
  task. Before trusting a checkmark, confirm the work is on disk and its check passes.
- **`spec.md` exists, no plan or tasks in this conversation:** look in the pull request
  (`gh pr view --json body`). If it has a plan and tasks, resume. Otherwise go to step 2: keep
  the spec, write the plan and tasks.

## 2. Write the spec, then the plan and tasks (no code yet)

1. Ask Paul for the ticket's scope if it isn't in the conversation. Don't guess a ticket from its
   title.
2. Read `AGENTS.md`, the requirement docs and ADRs the ticket touches, the `.claude/rules/` file
   for each area, and the code those areas already have.
3. If `specs/$ARGUMENTS/spec.md` is missing, copy `specs/TEMPLATE/spec.md` there and fill it in:
   the requirement IDs it satisfies, behavior, acceptance criteria (each checkable by a command,
   test or eval), and the failure modes (what happens when each dependency is down). If it exists
   and Paul approved it, don't rewrite it; raise a question instead.
4. Write the plan and the tasks **here in the chat** from `specs/TEMPLATE/plan.md` and `tasks.md`.
   - plan: files, functions with signatures, tests (and evals) written first, events and spans
     emitted, risks, and the questions Paul should be able to answer at the end.
   - tasks: small steps (about 10 minutes each), each with the command that proves it.
5. Mark anything you inferred rather than read as an open question.
6. **Stop.** Show Paul the spec, plan and tasks, and wait. When he approves, set the spec's
   `Status:` line to `approved by Paul`.

## 3. Work the tasks (after approval)

For each task, in order:

1. Write the test first when the task adds behavior. Run it and see it fail for the right reason.
2. Make the smallest change that passes. Stay inside the files the plan names.
3. Run `/verify`.
4. Tick the task in the chat's task list, with the check's summary line.
5. Explain the diff in a few plain sentences, then propose a commit (`NS-NNN: <what this adds>`).
   Commit only when Paul says so.

## 4. Finish

1. Delegate to `reviewer` with the ticket id, spec path and the approved plan (paste it: the
   reviewer hasn't seen this chat). Also to `security-reviewer` if the diff touches gateways,
   OAuth/secrets, untrusted-text agents, the extension, dependencies, `.claude/` or `.github/`.
   Fix critical findings, list the rest.
2. Update `AGENTS.md` and the matching rule file if a command, folder or convention changed.
3. Draft the PR body from `.github/pull_request_template.md`, with the plan, the ticked tasks and
   an honest AI assistance section.
4. `git push -u origin <branch>` (asks Paul). Write the PR body to a file in your temp directory
   and give Paul the line to open the PR himself:
   `! gh pr create --base main --head <branch> --title "..." --body-file <file>`.
   Wait for `checks` with `gh pr checks <n> --watch` (start it after the run appears).
5. When `checks` is green and no critical findings remain, read the head commit
   (`gh pr view <n> --json headRefOid`) and merge with
   `gh pr merge <n> --rebase --delete-branch --match-head-commit <sha>` (asks Paul). Then confirm
   the ticket's issue closed.

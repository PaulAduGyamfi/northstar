---
name: adr
description: Write an architecture decision record in docs/adr/ in Northstar's format. Use when a ticket makes a lasting choice (a dependency, service, data rule, contract, model tier, trade-off) or when Paul asks to record a decision.
argument-hint: "[short title of the decision]"
allowed-tools: Bash(ls docs/adr)
---

# Decision record: $ARGUMENTS

Existing records:

!`ls docs/adr`

1. **Number.** Take the highest number above and add one, four digits (`0010`). File name:
   `docs/adr/NNNN-<title-in-kebab-case>.md`. Never renumber or rewrite an accepted record. A
   decision that replaces one gets its own record, and the old one's Status becomes
   `Superseded by ADR-NNNN`.
2. **Read first.** `docs/adr/0002-approval-gate-and-action-gateways.md` is the house style. Read
   the ticket's spec and the approved plan for the facts, plus the requirement IDs involved.
3. **Write** with exactly these parts:

   ```markdown
   # ADR-NNNN — <the decision as a short phrase>

   **Status:** Proposed · **Date:** YYYY-MM-DD

   ## Context
   The problem in plain words, the requirement IDs it serves, what forces the choice.

   ## Decision
   What we do, specific enough to check in the code. Name packages, functions, numbers.

   ## Alternatives considered
   - Option: why not.

   ## Consequences
   - What gets easier, what gets harder, what we gave up, what we must now keep doing.
   ```

4. **Words.** Short sentences, active voice. Only facts you can point to. Mark anything uncertain
   as an open question instead of stating it.
5. Leave Status `Proposed`. Paul changes it to `Accepted`.
6. Link the record from the spec's "Rules that apply" and from the PR description.

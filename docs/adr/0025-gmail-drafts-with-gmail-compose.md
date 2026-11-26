# ADR-0025 — Gmail reply drafts with `gmail.compose`, created only after approval, never sent

**Status:** Proposed · **Date:** 2026-11-26

## Context
RPL-001 and RPL-002 ask for reply drafts to job email in Paul's voice, shown in the app's approval
queue and as Gmail drafts, with nothing sent without his approval. ADR-0014 gives Northstar only
`gmail.readonly`, with the access token in memory for one run, never stored. A Gmail draft can't
be created under that scope.

NS-166 (#117) asked Paul to decide the scope in an ADR. An agent decided it on 2026-11-26 under
his delegation ("Anything needed from my use your recommended choice"), and this ADR records that
decision. Google's `gmail.compose` scope can create drafts. It can also send them, so "never
sent" has to be enforced in code.

## Decision
1. Gmail drafts use `https://www.googleapis.com/auth/gmail.compose`, requested next to
   `gmail.readonly`. No other Gmail scope is added. `gmail.modify` is still not requested (labels
   are #238).
2. The token model stays ADR-0014's: desktop OAuth with PKCE, the access token in memory for one
   run, and no stored refresh token.
3. A draft is created only for a reply Paul approved in the Gate (ADR-0002). The Gmail draft
   writer calls `verifyApproval` with the approval's id and the draft's content hash at the moment
   it acts, the same way the Apply Gateway does. A changed draft needs a new approval.
4. Northstar never sends mail. The only Gmail write path is `users.drafts.create`. Paul sends
   from Gmail himself. A boundary test fails if any code calls `drafts.send` or `messages.send`,
   or builds those paths.
5. Each draft creation carries an idempotency key (the approval's id), so a retry never makes a
   second draft (RES-006). The draft's id goes into the domain event, and its text never does.
6. Paul adds the scope to the Google OAuth client's consent screen himself. Until then, the
   draft writer reports `needs_human` (`scope_missing`). It never asks for a broader scope.

## Alternatives considered
- **Show drafts only in the app, with no Gmail draft.** That needs no new scope, but RPL-002 asks
  for the Gmail draft, so Paul could reply from his normal mail client. It is still the fallback
  while the scope is missing.
- **`gmail.modify`.** It covers drafts and labels together, but it can also delete and archive
  mail. Labels get their own decision (#238).
- **Send approved replies from Northstar.** That would need the Gmail gateway to send under
  Paul's name. The decision on #117 is that Paul sends himself, so a bug or a prompt injection
  can never send mail.

## Consequences
- + Paul's replies are waiting in Gmail, in the thread, once he approves them.
- + Sending stays a human click in Gmail, whatever a bug or an injected email tries.
- − `gmail.compose` is broader than drafts alone. The boundary test and code review are what
  keep it to drafts.
- − Paul reconsents to the larger scope on each run (ADR-0014's model), and adds the scope to the
  OAuth client once.
- NS-166 slice 1 adds no Gmail code. The draft writer, its boundary test and the scope request
  come with the slice that files replies with the Gate.

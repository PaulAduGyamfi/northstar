# ADR-0027 — Gmail labels with `gmail.modify`, held only by a label writer that adds labels

**Status:** Rejected (Paul, by delegation to the orchestrator on 2026-11-27) · **Date:** 2026-11-26

> **Rejected.** `gmail.modify` also allows sending, trashing and archiving. The decision recorded
> on #89 was "no `gmail.modify`", and labels are organisation only, so Northstar stays unable to
> change Paul's mailbox. ADR-0014 stays as written (`gmail.readonly`). The label writer in
> `packages/inbox/src/labels/` keeps no caller, and no code may request the scope. Labels can be
> proposed again in a new ADR if Paul later wants them.

## Context
INB-008 puts an origin label on every linked thread (`Northstar/Started-by-Northstar` or
`Northstar/Outside`), and INB-005 adds type labels (`Northstar/Confirmation`, `/Interview`, …), so
the organisation shows in Gmail too. ADR-0014 gives Northstar `gmail.readonly`, with the access
token in memory for one run and never stored. ADR-0025 (Proposed) adds `gmail.compose` for drafts
only and left labels to #238.

Gmail can only add a label to a thread under `gmail.modify`. That scope also allows sending,
trashing, archiving and removing labels: everything except permanent deletion. #238 asks for a
decision on the scope and the token model. An agent decided it on 2026-11-26 under Paul's
delegation ("Anything needed from my use your recommended choice"), and this ADR records it.

## Decision
1. **Labels use `https://www.googleapis.com/auth/gmail.modify`.** Only a label writer
   (`packages/inbox/src/labels/`) receives a token with that scope.
   - It runs in its own OAuth flow, with **its own Google OAuth client**. Google can remember a
     grant per client and hand it back on a later consent, so sharing the reader's client could
     put `gmail.modify` into a read-only run.
   - Its token has its own type, `GmailLabelAccess`, which TypeScript can't pass where the mail
     reader's `GmailAccess` is expected, or the other way round. A type test proves both. Only
     the label consent flow constructs one.
   - The reader's exact-scope refusal stays (`authorizeGmail` refuses any grant other than
     `gmail.readonly`). It must never be loosened to get past a remembered grant.
   - The mail reader, triage, the Verification Catcher and the draft writer keep their own scopes.
   - So code that reads untrusted mail never holds a token that can change the mailbox.
2. **The token model stays ADR-0014's:** desktop OAuth with PKCE, the access token in memory for
   one run, no stored refresh token. A stored token waits for its own ADR, as ADR-0014 says.
3. **The writer makes three Gmail calls, and no other:**
   - `users.labels.list`;
   - `users.labels.create`, for names under `Northstar/` only;
   - `users.threads.modify` with `addLabelIds` only.

   It never removes a label, never touches a system label (INBOX, UNREAD, SPAM, TRASH,
   IMPORTANT, STARRED), and never sends, trashes, deletes, drafts or makes filters. These hold it
   to that:
   - **The guarantee is a runtime allowlist.** Every request passes `requestAllowed` first:
     exactly the labels URL (GET or POST), or a POST to one checked thread id's `modify` with a
     body whose only key is `addLabelIds`. Anything else is refused before it is sent.
   - Its label names come only from fixed tables in code, never from mail text or model output,
     and only Gmail ids of our own names are ever added.
   - A text scan in a boundary test is a tripwire, not the guarantee. It fails if any file under
     `src/labels/`, recursively, names a forbidden Gmail path, `removeLabelIds` or a method
     other than GET and POST.
4. **Labels don't go through the Approval Gate.** A label is organisation inside Paul's own
   mailbox: nothing goes out under his name, and he can remove it in one click. ADR-0002 covers
   what is sent, submitted or written outside.
5. **Repeating is safe.** Adding a label a thread already has changes nothing, and a label that
   already exists is looked up, not created twice (RES-006).
6. **The writer is guarded.** It runs behind the `gmail` breaker and its own `gmail_labels` kill
   switch (ADR-0007). A held-back call sends nothing and is retried by its caller.
7. **The caller records the feed event.** The writer emits a span (counts only). The mail-link
   loop that calls it writes one domain event per labelled thread, carrying the application id and
   the label count, never the thread id or the names (OBS-001).
8. **No code requests the scope until Paul accepts this ADR.** He also adds it to the Google OAuth
   client's consent screen himself. Until then the writer has no caller and labels show only in
   the app (INB-006's badges).

## Alternatives considered
- **`gmail.labels`.** It only manages the label list; it can't put a label on a thread.
- **A stored refresh token in the vault, for labelling between runs.** Labels aren't urgent
  enough to be the first stored Google credential. That decision belongs with the continuous
  inbox loop.
- **One `gmail.modify` token for the whole inbox.** It would hand a mailbox-changing token to the
  code that reads untrusted mail, so a prompt injection or a bug could reach send or trash.
- **No Gmail labels, only the app's badges.** INB-008 asks for both, and Paul reads mail in Gmail.

## Consequences
- + Gmail shows where each application thread came from, and its type, with no new app screen.
- + Sending, trashing and removing stay out of reach of the code that reads mail.
- − `gmail.modify` is much broader than labelling. The writer's isolation, its boundary test and
  review are what keep it to adding labels.
- − Paul consents to one more scope per run while the token model is per-run.
- NS-229 slice 1 adds the writer and its tests against a fake Gmail, with no scope request and no
  caller. The OAuth request and the mail-link loop's call follow once this is accepted (#224).

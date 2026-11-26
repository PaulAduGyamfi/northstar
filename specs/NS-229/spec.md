# NS-229: Gmail type and origin labels (slice 1: the ADR and the label writer)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: INB-005, INB-008 · ADR-0014, ADR-0025, ADR-0027 (Proposed).
GitHub issue #238 (Parent: #115).
Rules that apply: `.claude/rules/gateways.md`, `.claude/rules/tests.md`, `.claude/rules/llm.md`
(untrusted mail).

## Why
INB-008 puts `Northstar/Started-by-Northstar` or `Northstar/Outside` on every linked thread in
Gmail, and INB-005 adds type labels (`Northstar/Confirmation`, `/Interview`, …). ADR-0014 gives
Northstar `gmail.readonly` only, and applying a label needs `gmail.modify`. #238 asks for an ADR
that decides the scope and the token model, then the label writer.

## Behavior
1. **ADR-0027 (Proposed)** amends ADR-0014 for labels:
   - `gmail.modify` is held only by a separate label writer, under ADR-0014's token model
     (in memory for one run, no stored refresh token);
   - the writer makes three calls only: `labels.list`, `labels.create` under `Northstar/`, and
     `threads.modify` with `addLabelIds`;
   - labels are never removed, and system labels, trash and send are never touched;
   - labels are local organisation in Paul's own mailbox, so they don't go through the Gate;
   - no code requests the scope until Paul accepts the ADR.
2. **`threadLabels(kind, origin)`** (`packages/inbox/src/labels/names.ts`, plain code) gives a
   thread's label names:
   - **The type label** comes from the mail kind: confirmation → `Northstar/Confirmation`,
     rejection → `Northstar/Rejection`, assessment → `Northstar/Assessment`, interview request and
     scheduling → `Northstar/Interview`, recruiter → `Northstar/Recruiter`, follow-up needed →
     `Northstar/Follow-up`, offer → `Northstar/Offer`. `info_other`, or no kind, gives none.
   - **The origin label** comes from the origin bucket: `northstar` and `northstar_by_hand` →
     `Northstar/Started-by-Northstar`; `outside` and `recruiter_inbound` → `Northstar/Outside`;
     `unknown` gives none.
   - Names come only from these fixed tables, never from mail text.
3. **`createLabelWriter(deps).labelThread(threadId, names)`**, with its own token type
   `GmailLabelAccess`, which can't be passed to the mail reader (a type test)
   (`packages/inbox/src/labels/writer.ts`):
   - **Checks:** refuses any name not in the fixed set, and a thread id that isn't Gmail's plain
     id shape.
   - **Lookup:** reads the label ids (`labels.list`, once per writer) and creates only the
     missing `Northstar/…` labels. A 409 on create means another run made it, so it lists again.
   - **Apply:** calls `threads.modify` with `addLabelIds` only. Doing it twice gives the same
     labels (idempotent).
   - **Guarded:** each call goes through the `gmail` breaker and the `gmail_labels` kill switch
     (`admit`). Held back is a retryable `HeldBack`, with nothing sent.
   - **Failures:** an error names Gmail's status and reason only, and a span carries counts and
     statuses only.
   - **URLs** are built from constants and the checked ids, and every request passes the runtime
     allowlist `requestAllowed` first.
4. **A boundary test** (a tripwire under the allowlist) fails if any file under `src/labels/`,
   recursively, names a Gmail path for send, trash, delete, `removeLabelIds`, drafts or filters,
   or a method other than GET and POST.

## Acceptance criteria
- [ ] `threadLabels` maps every kind and origin as above.
- [ ] On a fake Gmail, the writer:
  - creates a missing label once;
  - applies with `addLabelIds` only;
  - running twice changes nothing more;
  - a 409 on create re-lists.
- [ ] Refusals: unknown names, a bad thread id, the kill switch off or the breaker open (`HeldBack`,
      no request).
- [ ] No token, mail text or label id appears in errors or spans.
- [ ] The boundary test passes, and fails when a forbidden path is added.
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Out of scope (follow-up issue, Parent: #238)
- The OAuth request for `gmail.modify` (after Paul accepts ADR-0027) and the caller in the
  mail-link loop (#224). Both need the loop and the accepted ADR.

## Decisions (ADR-0016)
- **The scope is decided in a Proposed ADR, under Paul's delegation on #115 and #117.** Nothing
  requests the scope until he accepts it.
- **The writer is built now against a fake Gmail.** It holds no token of its own, and no caller
  yet.
- **A new kill switch, `gmail_labels`.** It needs no schema: kill switches are named rows.
- **An unknown origin gets no origin label.** INB-008 says every linked thread gets one, but an
  application whose origin isn't known yet gets none rather than a guess.
- **The feed event is the caller's (#224).** It is one per labelled thread, with the application
  id and the label count only (ADR-0027 item 7).

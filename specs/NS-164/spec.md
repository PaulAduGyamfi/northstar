# NS-164: Classify linked job mail and decide its status change (slice 1)

Status: autonomous (ADR-0016; agent-planned, not reviewed by Paul before the build)
Requirements: INB-003 (classify), INB-004 (status from email, P2), INB-011 (sender proof),
INB-012 (verification mail never classified). GitHub issue #115. ADR-0004, ADR-0014.
Decision on #115 (Paul's delegation, 2026-11-26): start with classification and proposed status
updates under ADR-0014 (`gmail.readonly`, in-memory token). Defer labels (INB-005/008), which
need `gmail.modify`; they get their own issue and ADR.

## Why
NS-158 links job mail to applications, and NS-113's `mail-classify` route says what a message is.
Nothing yet turns "a rejection linked to application X" into a status change, and INB-011 says
when that change may happen by itself and when it must wait for Paul.

## Behavior
1. **`mailStatusChange`** (`packages/domain`, `mail-status.ts`): plain code, no I/O.
   - **Input:** the message's kind, the application's current status, and how it was linked:
     `source` (`match` when `matchMail` linked it, `other` for any other link) and
     `senderVerified` from `matchMail` (never `isAuthenticatedSender`, which any domain passes).
   - **Target status from the kind:**
     - `confirmation` → `confirmed`;
     - `assessment`, `interview_request`, `scheduling` → `in_process`;
     - `offer` → `offer`;
     - `rejection` → `rejected`;
     - `recruiter_inbound`, `follow_up_needed`, `info_other` → no change.
   - **A move only, never backwards:** the target must be an allowed move from the current
     status (`nextStatus`). Otherwise there is no change, with a reason (`same`, `not_a_move`).
     A confirmation after `in_process`, for example, changes nothing.
   - **Apply or propose (INB-011):** a change applies by itself only when the link is
     a `match` and `senderVerified` is true. Otherwise it becomes a proposal for Paul's
     confirm queue, naming why (`link_not_deterministic`, `sender_not_verified`).
2. **`classifyLinkedMail`** (`packages/inbox`, `triage.ts`): one fetched message in, its
   classification or a reason out. Rules and the model are the same as the backfill (NS-113).
   - **Verification mail is never classified (INB-012), from any sender.** It is skipped when
     its subject has a verification phrase or its body a code beside a code word (VER-003).
     - The backfill's checks are ATS-only, but linked mail can come from an employer's own
       portal or an assessment vendor (from the security review).
     - A false positive only skips a message.
   - **Rules first,** only for a sender Gmail authenticated (`classifyByRules`).
   - **Otherwise the `mail-classify` route.**
     - A refusal, truncated reply or invalid output goes to `review` with that reason.
     - So does a reply with no company.
     - So does a failed `checkMailProvenance` on the text the model saw.
   - **Errors:** a `HeldBack` (switch, breaker or spend cap) or a transport error is thrown to
     the caller, which retries later.
   - **Result:** the method (`rules` or `model`) and the call record's prompt version and model,
     never the body.

## Acceptance criteria
- [ ] A rejection that is deterministically linked and from a verified sender moves `submitted` to
      `rejected` (applies).
- [ ] The same rejection from an unverified sender is a proposal (`sender_not_verified`).
- [ ] A confirmation after `in_process` changes nothing (`not_a_move`), and a second rejection
      changes nothing either (`same`).
- [ ] `recruiter_inbound`, `follow_up_needed` and `info_other` never change a status.
- [ ] Verification mail never reaches the route, from an ATS or any other sender (a fake gateway
      counts calls).
- [ ] A model reply naming a company not in the email goes to review (`provenance`).
- [ ] `pnpm turbo run lint typecheck test build --force` exits 0, and `checks` is green.

## Known gaps
- **A magic link with no code and no verification subject** still reaches the model, as in the
  backfill: job mail often carries portal links, so a link alone can't mark verification mail.
- **An offer before `in_process`** (an offer on a `confirmed` application) changes nothing,
  because the state machine has no such move. #224 should surface it in the confirm queue rather
  than only storing the classification.
- **Two copies of the classification steps.** The backfill keeps its own (`backfill.ts`); a
  follow-up could make it call `classifyLinkedMail`.

## Out of scope
- **The loop:** fetching new mail, linking it, storing the classification, writing the status
  move or proposal, and the feed line. All of this is #224 (the mail-link loop), which calls
  these two functions.
- **Gmail labels (INB-005/008).** They need `gmail.modify`, which gets a follow-up issue and its
  own ADR.
- **Extracting contacts, dates, links and deadlines (INB-003).** That needs a new prompt version
  and its eval cases.

# NS-248 item 2: The credit report's inbox stages

Status: draft
Requirements: INB-010, INB-007, INB-003, INB-012
Rules that apply: ADR-0012, ADR-0016, `.claude/rules/db.md`, `.claude/rules/tests.md`
Issue: #294 item 2 (parent #224)

## Why
INB-010 asks for every stage (replied, screen, interview, offer) split by origin, so the app can
say "9 of 12 screens this month came from applications Northstar started". `readCreditReport`
(NS-188) counts submitted, in process and offer per origin bucket. The inbox stages waited on
stored triage results, and NS-261 now stores one classification per linked message
(`mail_classification`).

## Behavior
- New read-only `readInboxCreditReport(db, candidateId)` in `packages/db` (`origin-write.ts`, next
  to `readCreditReport`). For each origin bucket it counts the candidate's applications that
  reached:
  - **replied**: a classified message of any kind other than `confirmation` (an automatic receipt
    isn't a reply from the company);
  - **screen**: a classified message whose stage signal is `screen`;
  - **interview**: a classified message whose stage signal is `technical` or `onsite`.

  Each application counts at most once per stage. An application that reached interview but never
  had a `screen` signal isn't counted as screened.
- A message belongs to the application `mail_link` linked it to, or the one Paul chose in the
  confirm queue (`coalesce(mail_link.application_id, mail_link_decision.application_id)`, as the
  db rules say). Queued, undecided and dismissed messages count nowhere. Messages in review
  (`outcome = 'review'`) count nowhere.
- The origin bucket is the same `originBucket(foldOrigin(...))` `readCreditReport` uses, so the
  two reports agree on which bucket an application is in.
- `readCreditReport` and its type stay as they are. A separate reader keeps its existing test's
  assertion unchanged.
- Counts only: no subject, sender, company or message id leaves the function.

## Acceptance criteria
- [ ] A PGlite test: applications in different origin buckets with linked, classified mail are
      counted under replied, screen and interview by the rules above.
- [ ] A confirmation alone isn't a reply. Two replies on one application count once.
- [ ] A message in review, a queued message and a dismissed message count nowhere. A message Paul
      linked from the queue counts for the application he chose.
- [ ] Another candidate's mail and applications are left out.
- [ ] `pnpm --filter @northstar/db` lint, typecheck and test pass. `scripts/check-personal-data.sh`
      is clean on the changed files.

## Failure modes
Read-only queries on Postgres. A failed read throws to the caller. There is no caller yet, so
nothing is shown.

## Observability
No event and no span: a read like `readCreditReport`, which has none either. The future page or
command that shows it owns its span.

## Out of scope
- A page, API route or CLI for the report: no caller yet.
- Time windows ("this month"): the caller filters later. INB-010's example needs dates, so this
  slice returns all-time counts only.
- Rate or interval maths (`wilson`): the caller does that.
- Item 1 (the tagged address) merged in #388.

## Open questions
- "Replied" leaves out confirmations and counts rejections, because a rejection is the company
  answering. `pipelineMetrics`' "heard back" works from status moves, not mail, so the two can
  differ. The PR records this.

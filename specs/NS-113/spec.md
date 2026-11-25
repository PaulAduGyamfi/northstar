# NS-113: Gmail connect + 9-month funnel backfill + funnel report

Status: draft
Requirements: INB-001 (read only), INB-002, INB-009 steps 2–3, DX-001, DX-002, DX-003, DX-004,
DX-005, NFR-SEC-001/002/004/005
Rules that apply: ADR-0002, ADR-0004, ADR-0006, ADR-0007, ADR-0012, ADR-0013,
`.claude/rules/db.md`, `llm.md`, `tests.md`. A new ADR records the Gmail access decision below.

## Why
After nine months of searching, Paul doesn't know *which stage* of his funnel leaks: silence after
applying, screens that go nowhere, or technical rounds. 13-search-diagnostics says this diagnosis
comes first, because more volume doesn't fix a leak at stage C. The evidence is already in his
Gmail and in whatever tracker he kept. This ticket rebuilds the last nine months from both, then
reports conversion per stage, rejection latency and the most likely problem, with sample sizes so
it never guesses on thin data.

## Behavior

### Gmail, read only (INB-001, INB-002)
- `funnel backfill` connects to Gmail with Google's desktop OAuth flow: a browser consent page and
  a loopback redirect to `127.0.0.1` with PKCE. Scope: `gmail.readonly` only.
- **No stored credential.** The access token lives in memory for that run and is never written to
  disk, the database, logs, events or spans. Each run asks for consent again. The vault (NS-122)
  is not needed and not built here (see the new ADR).
- **Pre-filter before any content is read** (INB-002). Messages since `--since` (default
  `2026-02-01`, DX-001) are listed with a Gmail query built from known ATS sender domains and
  job-mail subject phrases. For each, only headers are fetched first (`From`, `Subject`, `Date`,
  `Delivered-To`, `Authentication-Results`). Plain code keeps a message only if its sender domain
  is a known ATS or already on a funnel record, or its subject matches a job-mail phrase. Only
  kept messages are fetched in full. Non-job mail is never fetched in full and never reaches a
  model (NFR-SEC-005).
- **Nothing from a message body is stored.** Only the Gmail message and thread ids, the sender
  domain, the date and the extracted fields below are kept (stricter than NFR-SEC-005's 90 days).

### Classifying and rebuilding the funnel (DX-001)
- **Rules first.** Known ATS confirmation subjects ("Thank you for applying", "We received your
  application", and similar) are classified `confirmation` by plain code.
- **Then the `mail-classify` route** (new, `claude-opus-5-5`, effort `low`) for the rest. Input:
  sender, subject, date and the body truncated to 6,000 characters, inside `untrustedBlock`. The
  route has no tools. Output (Zod): type (the INB-003 list), company, role, requisition id, and a
  stage signal (`none`, `screen`, `technical`, `onsite`, `offer`).
- **Provenance check (plain code).** The extracted company and role must appear verbatim in the
  sender, subject or body. Otherwise the message goes to the review queue, never into a record
  (ADR-0004).
- **Records.** Messages are grouped into one `funnel_record` per application: ATS thread or
  requisition id first, then normalized company plus role within 120 days (INB-009 steps 2–3).
  - Each record has the applied date (confirmation, or the earliest message) and the furthest
    stage reached (A applied, B any human response, C screen, D technical, E onsite or final, plus
    offer).
  - Its outcome is `rejected` (with the rejection date), `offer`, `open`, or `ghosted` (no message
    for 30 days after the last one).
  - Its source is `gmail`.
- **Review queue.** A message the classifier refused, truncated or returned invalid output for, a
  failed provenance check, or a message that fits two records becomes a review item.
  - `funnel review` walks the queue: assign the message to a record, create a new record, or
    discard it.
  - Nothing ambiguous lands in the data silently (DX-001's acceptance criterion).
- **Safe to repeat.** Each Gmail message id is processed once (`funnel_message`). A rerun skips
  known messages and costs no tokens for them.
- **Cost guard.** Before any model call, the run prints how many messages will be classified and
  an estimated cost, and stops at `--max-messages` (default 500).

### Manual history import (DX-002)
- `funnel import data/<file>.csv` reads a CSV with columns `company, role, applied_on,
  stage_reached, outcome, outcome_on, channel`, plus optional `notes` (ignored, never stored).
- A file with any bad row stores nothing; each bad row is listed by line number.
- Rows merge with Gmail records by normalized company and role with an applied date within 14
  days. A matched pair keeps the furthest stage. Conflicting outcomes become a review item, and
  the source becomes `both`. Re-importing the same file changes nothing.

### Funnel report (DX-003) and rejection latency (DX-005)
- `funnel report` prints:
  - counts per stage A→E and offers;
  - conversion between adjacent stages, with a 95% Wilson interval;
  - the assumed baseline for each step, shown as an assumption (DX-003);
  - the leakiest stage: the step furthest below its baseline whose interval sits wholly below it.
- With fewer than 20 data points at a stage, that step says "insufficient data" instead of a rate
  or a verdict.
- Baselines live in a committed file, `funnel-baselines.json`, each with a note on where the
  number comes from. Paul can change them; the report says "assumed" next to each.
- Rejection latency (DX-005): rejections bucketed by time from applied to rejected (< 24 h,
  1–7 d, > 7 d) plus "never". A high fast share is called out as a sign of knockout questions or
  ATS filters.
- Breakdowns by channel (where the CSV gives one) and by month.

### Hypothesis board (DX-004)
- `funnel hypotheses` gives each of H1–H11 a status (*supported*, *weakened* or *untested*), the
  evidence behind it in numbers, and the next test. Plain rules only:
  - **H2 / H10** (ATS filters, constraints): *supported* when ≥ 30% of rejections with known
    latency arrive in < 24 h and n ≥ 20.
  - **H6** (channel): *supported* when ≥ 85% of records are cold applies (needs CSV channels);
    *untested* without channel data.
  - **H11** (inconsistency): from the latest `profile.facts_checked` event (NS-112). *Supported*
    on any mismatch, *weakened* on none, *untested* if never checked.
  - **H4 / H8** (positioning, interview performance): from conversion at B→C and C→D compared
    with baseline, only when the leakiest-stage rule picks that step.
  - **H1, H3, H5, H9:** *untested*, with the data each needs named (e.g. "H1 needs posting dates:
    arrives with ATS polling, NS-115").
- A plain-language summary on top: "Most likely problem: X. Here's why. Here's what to do next."

## Acceptance criteria
- [ ] The OAuth flow requests exactly `gmail.readonly`, uses PKCE and a `127.0.0.1` loopback, and
      never writes the token anywhere. A test fakes Google's token endpoint and checks the
      database, events, spans and printed output for the token.
- [ ] Only messages that pass the pre-filter are fetched in full or sent to the model (test with
      a fake Gmail API: a newsletter is never fetched in full).
- [ ] Rules classify the known ATS confirmation subjects without a model call (test).
- [ ] A classification whose company or role isn't in the message goes to review, not into a
      record (test).
- [ ] A refused, truncated or invalid classification goes to review (tests, one per outcome).
- [ ] A synthetic 9-month mailbox fixture (≈ 40 messages across 12 applications) is rebuilt with
      the right stage and outcome for ≥ 90% of applications, and every uncertain one is in
      review (test with recorded `mail-classify` fixtures).
- [ ] Running the backfill twice makes no new records and no new model calls (test).
- [ ] CSV import: a bad row is refused by line number with nothing stored; a matching Gmail record
      merges; re-importing the same file changes nothing (tests).
- [ ] The report shows each stage's count, its sample size and "insufficient data" below 20, and
      names the leakiest stage only when its interval is below baseline (tests).
- [ ] Rejection latency buckets are right at the boundaries (exactly 24 h, exactly 7 d) (test).
- [ ] Each hypothesis rule gives *supported*, *weakened* and *untested* on its threshold edges
      (tests); H11 reads the NS-112 event.
- [ ] `mail-classify` has an eval set in `evals/mail-classify/` (≥ 30 synthetic cases, including
      prompt-injection emails), registered in `evals/src/routes.ts`, with a baseline from Paul's
      `--live` run and replay fixtures from his `--record` run. `eval --all` passes in CI.
- [ ] Events and spans carry counts and ids only: no subject, sender address, body, company or
      role (tests).
- [ ] `pnpm turbo run lint typecheck test build` and `pnpm --filter evals eval --all` pass.

## Failure modes
- **Google consent cancelled or timed out (2 min):** the run stops before reading anything and
  says how to retry. Nothing is written.
- **Gmail 429 or 5xx:** retry with jittered backoff and `Retry-After`, up to 5 times per call; then
  the run stops. Messages already processed are kept (idempotent), and a rerun resumes.
- **Gmail returns garbage** (missing headers, an unparseable date): that message goes to review
  with the reason. The run continues.
- **Claude API down:** `LlmTransportError` stops the run. Processed messages are kept; a rerun
  resumes. Refused, truncated or invalid output goes to review per message.
- **Budget:** the run never exceeds `--max-messages` model calls and prints the cost from the call
  records when it finishes (OBV-003).
- **Database down:** fails before contacting Google or the model, like the `profile` CLI.

## Observability
- Events (counts only):
  - `funnel.backfilled`: listed, prefiltered, fetched, rule-classified, model-classified, records
    created and updated, review items, cost.
  - `funnel.imported`: rows, merged, conflicts.
  - `funnel.reviewed`: per decision.
  - `funnel.reported`: the leakiest stage and sample sizes.
- Spans: `gmail.list`, `gmail.get` (attributes: count, http status, retry count; never subject or
  address), plus the `llm.call` span the gateway already emits.

## Out of scope
- Gmail push, labels, drafts, send and the Mail Gateway (INB-005, RPL-*, P2), and any stored
  token (NS-122).
- Linking new mail to live applications (INB-004), origin attribution (INB-007…012), the tagged
  address (VER-007): these need the Apply Gateway (NS-120).
- Inspecting which form answers knockout rejections had in common (second half of DX-005): there
  is no form-answer data until NS-120. The report says so.
- A web Today or Diagnostics view: the report is a CLI until `apps/web` lands.

## Open questions
1. **Where the code lives.** I propose two new packages, `packages/inbox` (Gmail read client,
   pre-filter, `mail-classify` route) and `packages/funnel` (records, import, report, hypotheses,
   CLI). Neither is in AGENTS.md's planned list, so you need to agree to this.
2. **Q-11:** which Gmail account? Default: your main one, with the pre-filter.
3. **Google OAuth client:** you create a "Desktop app" OAuth client in Google Cloud (Gmail API
   enabled, yourself as a test user) and put `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`. I add placeholders to `.env.example`.
4. **Baselines:** I'll propose starting values with their sources in `funnel-baselines.json`, all
   labelled "assumed". You should check them; the report is only as good as these.
5. **Your paid runs before merge:** `eval mail-classify --record` and `--live --update-baseline`
   (synthetic cases only). CI can't replay the new eval until they're committed.
6. **Thresholds I inferred:** 30-day ghosting, 120-day grouping window, 14-day CSV match window,
   the 30% fast-rejection and 85% cold-apply rules, 6,000-character body cap, 500-message cap.
7. **Size:** likely 3,000+ lines with tests and fixtures, ten times the "stop and ask" line. You
   chose one PR knowing that.

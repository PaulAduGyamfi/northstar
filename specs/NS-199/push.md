# NS-199 item 1: Push fresh-job alerts to Paul's phone

Status: slice 2 in review (slice 1 merged: #451; autonomous lane, ADR-0016)
Issue: #172 (parent #114, NS-163). Builds on NS-193 (#162: #442, #447, #449) and ADR-0032.
Requirements: SRC-015, SRC-012…016 (freshness first), RES-006, RES-007, OBS-001
Rules that apply: ADR-0002, ADR-0007, ADR-0016, ADR-0032, `.claude/rules/db.md`,
`.claude/rules/worker.md`, `.claude/rules/web.md`

## Why
A high-fit job under an hour old already gets a `job.fresh_alert` feed line ("Posted 12 min ago ·
Fit 88 · ready to approve"), but Paul only sees it when he opens the app. SRC-015 asks for a
priority push, and since NS-193 there is a push channel to his browsers.

## Behavior
Built in two slices, each its own PR:

1. **Storage and words (this PR).**
   - Migration: `push_notification.item_key` also accepts `job_fresh_alert:<jobId>:notify`. One
     claim per job, because the alert itself is once per job (`job.fresh_alert:<jobId>`).
   - `PushPayload` (`packages/domain`) gains `{ v: 1, kind: "fresh_job", id, age, fit }`: the
     job id, its age in whole minutes at the alert (0–1440) and its fit score (0–100). Never a
     title, company, place or URL. `pushWords` words it like the feed line: "A fresh job fits
     you" / "Posted 12 min ago · Fit 88. Open Northstar to see it." The service worker's copy
     follows, held equal by the parity test. A tap still opens Today.
   - `readFreshAlertsToNotify` (`packages/db`): the candidate's `job.fresh_alert` events that
     occurred in the last 60 minutes by the Gate's clock (`FRESH_PUSH_WINDOW_MINUTES`) and have no
     claim, oldest first, at most 20, with the job id, age and score from the event's payload.
     A held alert (`job.fresh_alert_held`) is never read: quiet hours stay what the alert pass
     decided, and a held alert is pushed when its `job.fresh_alert` is recorded after them.
   - `claimFreshJobNotification`: the one claim for that job's alert, only when the candidate's
     `job.fresh_alert` for it exists.
   - `recordPushResult` takes the claim's subject (a handoff or a fresh job) for the event's
     aggregate (`apply_handoff:<id>` or `job:<id>`) and its fixed-word feed line.
2. **The worker.** `notifyPass` pushes fresh-job alerts after the handoffs, under the same rules:
   nothing claimed while `push` is off or no browser listens, the switch asked before each claim,
   claim before send, a push no browser took or one held back is a `push.notify` dead letter, a
   held-back push stops the pass, and a claim with no result is reported, never re-sent.

## Acceptance criteria
- [ ] Slice 1: a fresh-job payload with any field beyond the five, a title, a URL or a value out
      of range is refused; its words are the feed line's numbers in fixed words.
- [ ] Slice 1: the reader lists a recent alert once, never a held one, never one older than the
      window, never one already claimed; a claim is taken once per job, and none for a job with no
      alert (db tests).
- [ ] Slice 2: one push per alert even when the pass runs twice; none while `push` is off, then
      sent once it is back on inside the window (worker tests).
- [ ] AGENTS.md, `.claude/rules/db.md` and `worker.md` describe each slice.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Failure modes
- Push service slow or down: the NS-193 sender's 10 s limit and the `push` breaker. Never retried
  (at most once): a push no browser took is a `push.notify` dead letter, as for handoffs.
- Push switched off or no browser subscribed: nothing is claimed; an alert still inside the
  window is pushed once it is back on, an older one never.
- A crash between claim and result: reported as `outcome_unknown` after the lease, never re-sent.
- Many fresh jobs at once: at most 20 claims a pass.

## Observability
- `push.sent` / `push.not_delivered` on the job's aggregate, ids and counts only; the alert's own
  feed line stays the place that names the score.
- The sender's `push.send` span (host, status, outcome).

## Out of scope
- A separate switch for job pushes (the `push` switch covers both).
- Approving from a push (#180).
- Opening the job's page from the push: a tap opens Today, never a URL.

## Decisions made without Paul
- Schema change (slice 1): widening one CHECK, no new table.
- Pushes only for alerts from the last 60 minutes, so a first subscription doesn't flood.

# NS-163: Fresh-job alerts

Status: accepted (autonomous lane, ADR-0016)
Requirements: SRC-015 (freshness first, SRC-012…016)
Rules that apply: ADR-0007, ADR-0016, `.claude/rules/db.md`, `.claude/rules/gateways.md`, `.claude/rules/tests.md`

## Why
A strong match is worth most in its first hour. When a high-fit job under an hour old appears,
Paul should hear about it at once ("Posted 12 min ago · Fit 88 · ready to approve"), but not at
3 a.m., unless the company is one of his tier-1 targets.

## Behavior
1. **The decision** (`packages/sources`, `alerts/fresh.ts`, plain code, no model): a job gets an
   alert when its latest fit score is in the `queue` band (the "high-fit" band Paul already
   sets with `queueAt`) and it is under 60 minutes old (posting time, else first seen).
   - Inside quiet hours the alert is **held**, unless the job comes from a tier-1 watched board
     and tier-1 alerts may break quiet hours (configurable).
   - A held alert is released on the first pass after quiet hours end, whatever the job's age
     by then.
   - Each job is alerted at most once, and held at most once.
2. **Tier** comes from the watchlist: a job's source URLs are matched to watched boards (same
   ATS and board name) by plain URL parsing. A job from no watched board has no tier.
3. **Settings** (`loadAlertConfig`, one typed config read in `bin.ts`): `ALERT_QUIET_HOURS`
   (`HH:MM-HH:MM`, may wrap midnight, default `22:00-07:00`, `off` for none),
   `ALERT_TIME_ZONE` (IANA name; default this machine's zone) and
   `ALERT_TIER1_IN_QUIET_HOURS` (`true`/`false`, default `true`). Bad values refuse to start
   with the setting's name, never its value.
4. **Storage** (`packages/db`, `alert-write.ts`, no migration): `readAlertCandidates` (queue-band
   jobs with their times, score, source URLs and alert state) and `recordFreshAlert` /
   `recordAlertHeld`, each one `domain_event` whose idempotency key is per job
   (`job.fresh_alert:<jobId>`, `job.fresh_alert_held:<jobId>`), so a repeat stores nothing.
5. **Delivery in this slice: the feed.** The alert event's `reason` is the alert sentence, which
   the feed shows (Today polls it every 3 s). A phone push needs the PWA's notification channel,
   which doesn't exist yet (follow-up issue).
6. **When it runs:** after every scoring pass (`jobs score`, `jobs add`, `jobs set`, each
   `jobs run` tick). An alert failure never fails scoring or the command.

## Acceptance criteria
- [ ] A synthetic fresh high-fit job produces exactly one alert, even when the pass runs twice.
- [ ] A job over an hour old, or below the queue band, gets no alert.
- [ ] Inside quiet hours the alert is held, and released once on the first pass after they end.
- [ ] A tier-1 job alerts inside quiet hours when allowed, and is held when not.
- [ ] Quiet hours that wrap midnight, and a time zone, are honoured.
- [ ] Bad settings are refused by name.
- [ ] Events carry the job id, score, age, tier and whether it was held; never a title, company
      or URL.

## Failure modes
- Database down during the alert pass: the pass throws inside the wrapper, scoring's result
  stands, the next pass retries (keys make it safe).
- Clock skew (a posting dated in the future): age counts as 0, so it can alert once.
- Many fresh jobs at once: each gets its own alert; no batching in this slice.

## Observability
- Events: `job.fresh_alert` (reason is the alert sentence) and `job.fresh_alert_held`.
- Span `sources.fresh_alerts` with counts `alerts.sent`, `alerts.held`, `alerts.released`.

## Out of scope
- Phone push through the PWA (needs the notification channel; follow-up).
- Quiet hours as an in-app setting (follow-up with the preferences UI; a migration).
- SRC-016 posting-pattern learning.

## Open questions
- "High-fit" is read as the `queue` band (score ≥ `queueAt`, default 80), so it follows Paul's own
  threshold rather than a new number.

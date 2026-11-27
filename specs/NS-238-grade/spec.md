# NS-238 item 1, slice 2: `funnel inbox` grades recruiter mail, behind `RECRUITER_EXTRACT`

Status: in progress (autonomous lane, ADR-0016)
Issue: #266 item 1 (parent #118)
Requirements: REC-001, REC-002 (grade only), INB-003
Rules that apply: ADR-0004 (code decides), ADR-0014, ADR-0016, ADR-0021, `.claude/rules/db.md`,
`.claude/rules/llm.md`, `.claude/rules/tests.md`

## Why
Slice 1 (#413) links and sorts new job mail, but recruiter mail waits ungraded. #266 item 1: each
`recruiter_inbound` message is graded once its classification is stored, the grade and reason codes
stored (never email text) with a feed line, and the Inbox shows it (it already does, NS-238 slice 1).

## Behavior
After sorting, the same `funnel inbox` run grades recruiter mail:
1. **The switch.** `RECRUITER_EXTRACT` (`on` or `off`, default `off`), read through the funnel's
   typed config loader (`loadFunnelConfig`, `src/config.ts`); any other value stops the command
   before Gmail is asked, naming the setting. A placeholder sits in `.env.example`'s Apps part.
   With it off, nothing is read or sent: the run counts the recruiter mail waiting, as in slice 1.
   Turning it on is Paul's (#266: after his recorded fixtures). The route also runs only while the
   `agent:recruiter-extract` switch is on, the `anthropic` breaker allows it and the spend cap
   isn't reached (it is a `normal` route).
2. **Which mail.** Up to 10 a run, newest first: messages classified `recruiter_inbound`, with no
   grade, not dismissed by Paul, and not passed over for a `mail.grade` letter (the slice 1 rule:
   passed over unless Paul's newest resolution is Retry) (`readUngradedRecruiterMail`).
3. **Grading.** Each is read in full (`getFull`, in memory only), its body goes to
   `extractRecruiterFacts` (the route, then `checkRecruiterFacts`), and plain code grades the
   checked facts against Paul's current search preferences (`gradeRecruiterMessage`,
   `PREFERENCE_DEFAULTS` before he sets any), matching dealbreakers against the body too. **No
   learned weights**: the stored grade stays the grader's own, so learning (NS-238 item 3) keeps
   measuring against it. `recordRecruiterGrade` stores the letter, points, reason codes and
   confidence with its `recruiter.graded` feed line.
4. **Failures.** The route refusing, cutting off or answering out of shape, a message Gmail no
   longer has, or a grade the store refuses becomes a `mail.grade` dead letter (reasons `refused`,
   `truncated`, `invalid_output`, `read_failed`, `grade_failed`, `record_refused`); the message is
   passed over until Paul retries it. A held-back call, the Claude API or Gmail not answering stops
   grading for the run with no letter.
5. **Output.** Counts only: graded, couldn't grade, left for later, or waiting because grading is
   off. Never a letter per email, a company, a subject or an id.

No reply drafts (item 2), no status change, nothing sent.

## Dependency
`@northstar/funnel` now depends on `@northstar/sources` (workspace, no third-party package) for
`gradeRecruiterMessage`. Approved by the orchestrator under Paul's standing delegation; the lock
file changes only in the funnel's importers entry (added on Node 24 by the orchestrator).

## Acceptance criteria
- [ ] `loadFunnelConfig`: on, off, unset (off), and any other value refused by name (tests).
- [ ] The grading step: off reads nothing; on grades at most 10, stores codes only, letters each
      failure kind, passes over lettered messages, stops on a held-back call or API outage (tests).
- [ ] `readUngradedRecruiterMail`: classified recruiter mail with no grade and no dismissal,
      newest first, the candidate's own (PGlite).
- [ ] `mail.grade` is on `DEAD_LETTER_KINDS` with words on /health.
- [ ] lint, typecheck, test, build green (CI `checks`).

## Decisions made without Paul
- 10 grades a run at most (each is a `normal`-priority model call).
- No learned weights on stored grades (the item 3 spec's rule for the caller).
- The route sees the body only, as its eval cases do.

## Out of scope
- Reply drafts by grade (item 2), the agreement measure (item 4), turning the route on.

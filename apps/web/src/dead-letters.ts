import { z } from "zod";

// Stuck work (NS-215, RES-007): the API's open dead letters and the plain words they are shown in,
// including what happens after Paul's retry, skip or hand-off.

export const DeadLettersBody = z.object({
  items: z.array(
    z.object({
      deadLetterId: z.string(),
      kind: z.string(),
      reasonCode: z.string(),
      attempts: z.number(),
      deadAt: z.string(),
    }),
  ),
});
export type DeadLetterItem = z.infer<typeof DeadLettersBody>["items"][number];

export const DEAD_LETTER_ACTIONS = ["retry", "skip", "hand_off"] as const;
export type DeadLetterAction = (typeof DEAD_LETTER_ACTIONS)[number];

export const ACTION_LABELS: Record<DeadLetterAction, string> = {
  retry: "Retry",
  skip: "Skip",
  hand_off: "Hand off",
};

type KindWords = { what: string; next: Record<DeadLetterAction, string> };

// Each producer's kind, in words. A kind not listed still shows, as itself.
const KINDS: Record<string, KindWords> = {
  "apply.stale_sweep": {
    what: "Closing stale application claims",
    next: {
      // The sweep retries on its own every pass (apps/worker sweep.ts): no action starts work.
      retry:
        "Nothing runs now: the sweep already tries again on every pass, every few minutes. If it keeps failing, a new item shows here.",
      skip: "Nothing more is done about this pass. Later passes still run.",
      hand_off:
        "Nothing runs now: the sweep keeps trying on its own passes. There's no page for open claims yet, so check the Apply ledger in the database if this keeps happening.",
    },
  },
  // NS-226: a submission run that ended without being sent (apps/worker ending.ts). Resolving a
  // letter only records Paul's choice: nothing restarts a submission from here yet.
  "apply.submission": {
    what: "Submitting an application",
    next: {
      retry:
        "Nothing runs now: a submission can't be restarted from here yet. The application stays where it is on the Pipeline.",
      skip: "Nothing more is done about this run. The application stays where it is on the Pipeline.",
      hand_off:
        "Nothing runs now. Check the application on the Pipeline and your email first: the run may already have sent it, or the job may have closed. Only if it wasn't sent, apply on the job's own page yourself.",
    },
  },
  // NS-213 slice 2: a pass of the relay that tells waiting submissions about Paul's decisions
  // (apps/worker relay.ts). It reads again on every pass, so resolving only records his choice.
  "apply.signal_relay": {
    what: "Passing your approval decisions to waiting submissions",
    next: {
      retry:
        "Nothing runs now: the relay already tries again every minute. If it keeps failing, a new item shows here.",
      skip: "Nothing more is done about this pass. Later passes still run.",
      hand_off:
        "Nothing runs now: the relay keeps trying on its own. If items keep showing here, an approved application may be waiting; check the worker on this page.",
    },
  },
  // NS-240: a detected interview the store refused. Resolving only records Paul's choice; the
  // next calendar check reads the window again on its own.
  "calendar.interview_detection": {
    what: "Finding interviews on your calendar",
    next: {
      retry:
        "Nothing runs now: the next calendar check looks again. An event that changed too many times stays out, and the daily limit clears after a day.",
      skip: "Nothing more is done about this item. Later calendar checks still run.",
      hand_off:
        "Nothing runs now. Check your calendar for the interview yourself: an invite that keeps changing, or many at once, may not be from the company.",
    },
  },
  // NS-241 slice 4: an approved prep plan the Calendar writer couldn't write. Blocks already
  // written stay, and a rerun writes each block once (its event id comes from the approval).
  "calendar.prep_write": {
    what: "Adding approved prep blocks to your Northstar calendar",
    next: {
      retry:
        "Nothing runs now: the next time you add prep blocks, this plan is tried again. Blocks already added aren't added twice.",
      skip: "Nothing more is done about this plan. Blocks already added stay on your Northstar calendar.",
      hand_off:
        "Nothing runs now. Add the prep blocks to your calendar yourself; any already added stay on your Northstar calendar.",
    },
  },
  // NS-238 item 1: an email that stopped `funnel inbox` from reading new mail three times in a
  // run. Later runs pass over it until Paul retries it.
  "mail.poll": {
    what: "Reading new job mail",
    next: {
      retry: "The next `funnel inbox` run reads this email again.",
      skip: "Later `funnel inbox` runs pass over this email.",
      hand_off:
        "Later `funnel inbox` runs pass over this email. Look through your recent job mail in Gmail yourself: one email in it can't be read here.",
    },
  },
  // NS-238 item 1 slice 2: a recruiter email `funnel inbox` couldn't grade.
  "mail.grade": {
    what: "Grading a recruiter email",
    next: {
      retry: "The next `funnel inbox` run tries to grade this email again.",
      skip: "Later `funnel inbox` runs leave this email ungraded.",
      hand_off:
        "Later `funnel inbox` runs leave this email ungraded. It is still on /inbox; read it in Gmail from there and decide yourself.",
    },
  },
  // NS-238 item 2's caller: a graded recruiter email `funnel inbox` couldn't file a reply for.
  // Nothing was sent or put in Gmail.
  "mail.reply": {
    what: "Preparing a reply to a recruiter email",
    next: {
      retry: "The next `funnel inbox` run tries to prepare this reply again.",
      skip: "Later `funnel inbox` runs prepare no reply to this email.",
      hand_off:
        "Later `funnel inbox` runs prepare no reply to this email. It is still on /inbox; open it in Gmail from there and reply yourself if you want to.",
    },
  },
  // NS-193 slice 3: a notification about a handoff, or (NS-199) a fresh job, that didn't reach any
  // browser, or whose outcome is unknown. The handoff or job itself stays where it was (Today, or
  // the jobs page); nothing is pushed again (at most once).
  "push.notify": {
    what: "Sending you a notification",
    next: {
      retry:
        'Nothing is sent again: each item gets at most one notification. An application that needs your hands is still on Today under "Needs your hands", and a fresh job is still on the jobs page.',
      skip: "Nothing more is done about this notification. What it was about is still on Today or the jobs page.",
      hand_off:
        'Nothing is sent again. Check "Needs your hands" on Today and the jobs page yourself; check /health if notifications keep failing.',
    },
  },
  // NS-238 item 1: a recorded email `funnel inbox` couldn't read or sort.
  "mail.classify": {
    what: "Sorting a job email",
    next: {
      retry: "The next `funnel inbox` run tries to sort this email again.",
      skip: "Later `funnel inbox` runs leave this email unsorted.",
      hand_off:
        "Later `funnel inbox` runs leave this email unsorted. It is still on /inbox; open it in Gmail from there and read it yourself.",
    },
  },
};

const REASONS: Record<string, string> = {
  sweep_failed: "every attempt failed",
  relay_failed: "every attempt failed",
  activity_failed: "every attempt to run it failed",
  too_many_changes: "one calendar event changed too many times",
  daily_limit: "too many possible interviews in one day",
  invalid_detection: "the calendar event couldn't be stored as it is",
  unknown_application: "its application wasn't found",
  write_failed: "every attempt to write to Google Calendar failed",
  claims_exhausted: "too many runs stopped part-way",
  plan_not_found: "its stored plan wasn't found",
  plan_changed: "its stored plan changed after you approved it",
  approval_not_valid: "its approval no longer stands",
  rescheduled: "the interview moved and the old approval couldn't be closed",
  read_failed: "Gmail wouldn't give the email",
  step_failed: "linking it to your applications failed",
  classify_failed: "sorting it failed",
  record_refused: "its result couldn't be stored",
  refused: "the model declined to read it",
  truncated: "the model's answer was cut off",
  invalid_output: "the model's answer was malformed",
  grade_failed: "grading it failed",
  invalid_headers: "its sender, subject or thread headers can't be replied to safely",
  no_reply_address: "it came from a no-reply address",
  file_refused: "your approval queue refused the reply",
  unknown_grade: "its stored grade isn't one this version knows",
  not_delivered: "no browser took the notification",
  push_paused: "notifications were paused (the push switch or its breaker) when it was sent",
  outcome_unknown: "a run stopped before it knew whether the notification went out",
  notify_failed: "every attempt failed",
};

// Own keys only: a code such as "constructor" must not find Object's built-ins.
const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

// One letter as shown: what stopped, why, after how many attempts and when.
export function letterLine(item: DeadLetterItem): { what: string; why: string } {
  const what = own(KINDS, item.kind)?.what ?? item.kind;
  const reason = own(REASONS, item.reasonCode) ?? item.reasonCode.replaceAll("_", " ");
  const attempts = item.attempts === 1 ? "1 attempt" : `${item.attempts} attempts`;
  return { what, why: `Stopped after ${attempts}: ${reason}` };
}

// What happens next after an action, in words.
export function nextStep(kind: string, action: DeadLetterAction): string {
  const words = own(KINDS, kind)?.next[action];
  if (words) return words;
  return {
    retry: "Sent back to be tried again.",
    skip: "Skipped; it won't be tried again.",
    hand_off: "Handed off for you to do by hand.",
  }[action];
}

// The message for an API refusal code; already resolved counts as done (a resolve is once only).
export function resolveMessage(code: unknown): string {
  if (code === "already_resolved") return "That was already resolved.";
  if (code === "not_found") return "That letter isn't there any more. Reload the page.";
  if (code === "unauthenticated") return "You've been signed out. Sign in again.";
  return "That didn't work. Try again.";
}

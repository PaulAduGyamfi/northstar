import type { ApprovedPrepPlan, FiledPrepPlan, StoredInterview } from "@northstar/db";
import { PREP_DAYS, type Result } from "@northstar/domain";
import type { PrepRefusal, PrepWritten } from "@northstar/gateways";
import type { PrepConfig } from "./config.js";
import { errorName, type LetterRow, letterKey, letterState } from "./inbox.js";

// `funnel prep` (NS-241 slice 5, CAL-003, ADR-0031): the command Paul runs to plan prep for his
// confirmed interviews, file each plan with the Approval Gate, and write the plans he approved
// onto his Northstar calendar. Google consent is asked on this run only (#400: no stored token):
// the writer's only when there is something approved to write, and, with --busy-from-calendar
// (slice 7), the read-only one only when something is about to be planned. Plain code over ports.

// Why a plan went to Stuck work: a write that threw, or a refusal that no later run can clear.
export type PrepLetterReason =
  | "write_failed"
  | "claims_exhausted"
  // The writer found no stored plan for the request, or the stored plan no longer hashes to what
  // was approved.
  | "plan_not_found"
  | "plan_changed"
  // The Gate refused the decision for a reason that doesn't pass with time.
  | "approval_not_valid"
  // The interview moved and the Gate wouldn't close the old approval.
  | "rescheduled";

export type PrepBlock = { kind: "prep" | "warm_up"; start: Date; end: Date };
export type BusyInterval = { start: Date; end: Date };
// PrepRequest's own bound on busy intervals (packages/db).
export const MAX_BUSY = 500;
// A plan as Paul sees it in his terminal on the run that files it (the Queue shows it too).
export type FiledPlanView = { interviewStart: Date; blocks: PrepBlock[] };
export type PlannedProposal = { proposalId: string; blocks: PrepBlock[] };

// What the run did with each step's answers. Printed only to Paul's own terminal.
export type PrepRunReport = {
  // The zone the times below are shown in.
  timeZone: string;
  proposed: number;
  // Interviews whose proposal was refused (started, replaced by a reschedule, no longer confirmed).
  notProposed: number;
  filed: number;
  // The plans sent to the Queue this run, so Paul knows what he is approving.
  newPlans: FiledPlanView[];
  // Filed on an earlier run (waiting, decided or closed): nothing new to file.
  waiting: number;
  // Not filed: the interview was rescheduled, unconfirmed, or the planner placed nothing.
  notFiled: number;
  // Approved plans this run tried to write.
  approved: number;
  written: number;
  // Approved plans held back this run (switch, breaker, another run's claim, undo window, or a
  // reschedule whose approval was closed); a later run tries again.
  skipped: number;
  // Approved plans passed over because they are in Stuck work, waiting for Paul.
  passedOver: number;
  // Plans that went to Stuck work this run.
  stuck: number;
  // The grant lacks calendar.app.created: Paul enables it, then reruns.
  scopeMissing: boolean;
  // Why writing stopped early (consent or Google not answering), by the error's name.
  writeStoppedBy: string | null;
  // Paul's own calendar as busy time (slice 7, `--busy-from-calendar`): null when not asked for
  // or when nothing needed planning; else how many events were read, or the error's class name.
  calendarBusy: { read: number } | { failedBy: string } | null;
};

export type PrepWriter = (plan: ApprovedPrepPlan) => Promise<Result<PrepWritten, PrepRefusal>>;

export type PrepRunDeps = {
  config: PrepConfig;
  now: () => Date;
  // The candidate's current interview detections with Paul's decisions (listInterviews).
  interviews: () => Promise<readonly StoredInterview[]>;
  // The stored proposal for a detection, or null (readPrepProposal).
  proposalOf: (detectionId: string) => Promise<PlannedProposal | null>;
  // proposeInterviewPrep, with busy time from what is stored (slice 6).
  propose: (
    detectionId: string,
    request: {
      busy: BusyInterval[];
      workingHours: PrepConfig["workingHours"];
      timeZone: string;
      now: Date;
    },
  ) => Promise<Result<PlannedProposal, { kind: string }>>;
  // requestPrepPlanApproval.
  file: (proposalId: string) => Promise<Result<FiledPrepPlan, { kind: string }>>;
  // readApprovedPrepPlans.
  approved: () => Promise<readonly ApprovedPrepPlan[]>;
  // Every `calendar.prep_write` letter with Paul's resolution (readDeadLetterKeys).
  letters: () => Promise<readonly LetterRow[]>;
  recordLetter: (plan: ApprovedPrepPlan, reason: PrepLetterReason, key: string) => Promise<void>;
  // Asks Calendar write consent for this run and returns the writer bound to that token.
  consent: () => Promise<PrepWriter>;
  // Only with `--busy-from-calendar` (slice 7): asks read-only Calendar consent for this run and
  // gives the primary calendar's events in the window as start and end times only.
  calendarBusy?: (window: { timeMin: Date; timeMax: Date }) => Promise<BusyInterval[]>;
};

export async function runPrep(deps: PrepRunDeps): Promise<PrepRunReport> {
  const r: PrepRunReport = {
    timeZone: deps.config.timeZone,
    proposed: 0,
    notProposed: 0,
    filed: 0,
    newPlans: [],
    waiting: 0,
    notFiled: 0,
    approved: 0,
    written: 0,
    skipped: 0,
    passedOver: 0,
    stuck: 0,
    scopeMissing: false,
    writeStoppedBy: null,
    calendarBusy: null,
  };
  const now = deps.now();
  const all = await deps.interviews();
  // Only interviews Paul confirmed that are still ahead: a started one gets no plan.
  const upcoming = all.filter(
    (i) => i.decision === "confirmed" && i.start.getTime() > now.getTime(),
  );
  // Read every stored proposal first, so the first interview planned already sees the others'
  // blocks as busy. Only confirmed, upcoming interviews can have one that matters: a proposal needs
  // a confirmed current detection, and a past interview's blocks are past.
  const stored = new Map<string, PlannedProposal | null>();
  for (const interview of upcoming) {
    stored.set(interview.detectionId, await deps.proposalOf(interview.detectionId));
  }
  // Busy time from what Northstar already knows: every other interview not dismissed and not
  // over, and every stored proposal's blocks (slice 6); with --busy-from-calendar also Paul's own
  // calendar's events (slice 7).
  const blockBusy: BusyInterval[] = [...stored.values()].flatMap((p) =>
    p === null ? [] : p.blocks.map((b) => ({ start: b.start, end: b.end })),
  );
  const interviewBusy = all.filter(
    (i) => i.decision !== "dismissed" && i.end.getTime() > now.getTime(),
  );
  // Paul's own calendar, only on request and only when something is about to be planned (slice 7).
  const calendar = await readCalendarBusy(deps, upcoming, stored, now, r);
  for (const interview of upcoming) {
    let proposal = stored.get(interview.detectionId) ?? null;
    if (proposal === null) {
      const proposed = await deps.propose(interview.detectionId, {
        busy: busyFor(
          interview.detectionId,
          interviewBusy,
          blockBusy,
          calendarNear(calendar, interview.start),
        ),
        workingHours: deps.config.workingHours,
        timeZone: deps.config.timeZone,
        now,
      });
      if (!proposed.ok) {
        r.notProposed++;
        continue;
      }
      r.proposed++;
      proposal = proposed.value;
      // A plan made now is busy time for the interviews planned after it in this run.
      for (const b of proposal.blocks) blockBusy.push({ start: b.start, end: b.end });
    }
    // Filing is idempotent: a plan already filed answers its first request.
    const filed = await deps.file(proposal.proposalId);
    if (!filed.ok) r.notFiled++;
    else if (filed.value.stored) {
      r.filed++;
      r.newPlans.push({ interviewStart: interview.start, blocks: proposal.blocks });
    } else r.waiting++;
  }
  await writeApproved(deps, r);
  return r;
}

// The busy time for one interview's plan: the other interviews and the stored blocks, never the
// interview itself (the planner adds it), at most MAX_BUSY: the ones that start soonest, since
// prep lands in the days just before an interview.
export function busyFor(
  detectionId: string,
  interviews: readonly StoredInterview[],
  blocks: readonly BusyInterval[],
  calendar: readonly BusyInterval[] = [],
): BusyInterval[] {
  const others = interviews
    .filter((i) => i.detectionId !== detectionId)
    .map((i) => ({ start: i.start, end: i.end }));
  return [...others, ...blocks, ...calendar]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_BUSY);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A long calendar could fill MAX_BUSY with meetings weeks before an interview and push out the
// days its prep can use, so each plan gets only the calendar events that overlap those days:
// PREP_DAYS before the interview, plus a day of slack for the time zone's midnight, up to its start.
export function calendarNear(
  calendar: readonly BusyInterval[],
  interviewStart: Date,
): BusyInterval[] {
  const from = interviewStart.getTime() - (PREP_DAYS + 1) * DAY_MS;
  return calendar.filter(
    (b) => b.end.getTime() > from && b.start.getTime() < interviewStart.getTime(),
  );
}

// The read-only Calendar client's own limit on one window (packages/inbox, MAX_WINDOW_DAYS).
export const CALENDAR_WINDOW_DAYS = 60;

// Reads Paul's calendar once for the interviews about to be planned: from now to the latest one's
// start, at most CALENDAR_WINDOW_DAYS. Consent or Google failing never stops the run: it plans with
// stored busy time and the report says why, by the error's class name only.
async function readCalendarBusy(
  deps: PrepRunDeps,
  upcoming: readonly StoredInterview[],
  stored: ReadonlyMap<string, PlannedProposal | null>,
  now: Date,
  r: PrepRunReport,
): Promise<BusyInterval[]> {
  if (!deps.calendarBusy) return [];
  const toPlan = upcoming.filter((i) => (stored.get(i.detectionId) ?? null) === null);
  // Nothing to plan: no consent page for nothing.
  if (toPlan.length === 0) return [];
  const latest = Math.max(...toPlan.map((i) => i.start.getTime()));
  const timeMax = new Date(Math.min(latest, now.getTime() + CALENDAR_WINDOW_DAYS * DAY_MS));
  try {
    const events = await deps.calendarBusy({ timeMin: now, timeMax });
    r.calendarBusy = { read: events.length };
    // Start and end only, whatever the port handed back.
    return events.map((e) => ({ start: e.start, end: e.end }));
  } catch (e) {
    r.calendarBusy = { failedBy: errorName(e) };
    return [];
  }
}

// A refusal that no later run can clear goes to Stuck work; the others wait for a later run.
function lasting(refusal: PrepRefusal): PrepLetterReason | null {
  switch (refusal.kind) {
    case "NotFound":
      return "plan_not_found";
    case "ContentMismatch":
      return "plan_changed";
    // The undo window passes; any other Gate refusal stays.
    case "NotApproved":
      return refusal.reason === "UndoWindowOpen" ? null : "approval_not_valid";
    // A closed approval leaves the list; one the Gate wouldn't close stays on it for good.
    case "Rescheduled":
      return refusal.withdrawn ? null : "rescheduled";
    case "InProgress":
    case "HeldBack":
      return null;
  }
}

async function writeApproved(deps: PrepRunDeps, r: PrepRunReport): Promise<void> {
  const letters = letterState(await deps.letters(), "calendar.prep_write");
  const all = await deps.approved();
  const plans = all.filter((p) => !letters.passOver.has(p.decisionId));
  r.passedOver = all.length - plans.length;
  // Nothing approved: no consent page for nothing.
  if (plans.length === 0) return;
  let write: PrepWriter;
  try {
    write = await deps.consent();
  } catch (e) {
    r.writeStoppedBy = errorName(e);
    return;
  }
  const giveUp = async (plan: ApprovedPrepPlan, reason: PrepLetterReason) => {
    await deps.recordLetter(
      plan,
      reason,
      letterKey("calendar.prep_write", plan.decisionId, letters.count),
    );
    r.stuck++;
  };
  for (const plan of plans) {
    r.approved++;
    let answer: Result<PrepWritten, PrepRefusal>;
    try {
      answer = await write(plan);
    } catch (e) {
      // Google not answering is about Google, not this plan: stop, with no letter, and a later
      // run continues (the claim's lease lets it). The breaker counts these.
      if (googleDown(e)) {
        r.writeStoppedBy = errorName(e);
        return;
      }
      // The claim stays; the ledger's lease lets a later run continue. Paul sees it in Stuck work.
      await giveUp(
        plan,
        errorName(e) === "PrepClaimsExhausted" ? "claims_exhausted" : "write_failed",
      );
      continue;
    }
    if (!answer.ok) {
      const reason = lasting(answer.error);
      if (reason === null) r.skipped++;
      else await giveUp(plan, reason);
      continue;
    }
    if (answer.value.kind === "needs_human") {
      // The grant can't write: every other plan would answer the same.
      r.scopeMissing = true;
      return;
    }
    r.written++;
  }
}

// The Calendar writer's own failure (CalendarWriteError) with no answer, a rate limit or a server
// error: Google is down or busy, so every plan would fail the same way.
function googleDown(e: unknown): boolean {
  if (errorName(e) !== "CalendarWriteError") return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && (status === 0 || status === 429 || status >= 500);
}

export type PrepDeps = {
  print: (line: string) => void;
  runPrep: () => Promise<PrepRunReport>;
};

const BLOCK_WORDS: Record<PrepBlock["kind"], string> = { prep: "prep", warm_up: "warm-up" };

// One plan in Paul's own zone, e.g. "Interview Tue, Dec 1, 10:00: prep Mon, Nov 30, 09:00-09:45;
// warm-up Tue, Dec 1, 09:00-09:15." Printed to his terminal only, never stored or logged.
export function planLine(plan: FiledPlanView, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const blocks = plan.blocks
    .map((b) => `${BLOCK_WORDS[b.kind]} ${day.format(b.start)}-${time.format(b.end)}`)
    .join("; ");
  // The planner may place nothing (no free working time before the interview).
  return `Interview ${day.format(plan.interviewStart)}: ${blocks === "" ? "no blocks fit" : blocks}.`;
}

export async function prepCommand(deps: PrepDeps): Promise<number> {
  let r: PrepRunReport;
  try {
    r = await deps.runPrep();
  } catch (error) {
    deps.print(`Interview prep stopped: ${describeError(error)}`);
    deps.print("What was saved stays; run it again to retry.");
    return 1;
  }
  deps.print(
    `Prep proposed for ${r.proposed} interview(s)${r.notProposed > 0 ? ` (${r.notProposed} couldn't be planned: started, rescheduled or no longer confirmed)` : ""}.`,
  );
  deps.print(
    `Sent to your Queue for approval: ${r.filed}. Sent on an earlier run: ${r.waiting}. Not sent: ${r.notFiled}.`,
  );
  if (r.calendarBusy !== null) deps.print(calendarLine(r.calendarBusy));
  for (const plan of r.newPlans) deps.print(planLine(plan, r.timeZone));
  let code = 0;
  if (r.writeStoppedBy !== null) {
    deps.print(
      `Written to your Northstar calendar: ${r.written}. The rest wasn't: Google's consent didn't finish or Google didn't answer (${r.writeStoppedBy}). Run it again later; nothing is written twice.`,
    );
    code = 1;
  } else if (r.scopeMissing) {
    deps.print(
      "Approved plans weren't written: Google didn't grant calendar access for the Northstar calendar. Allow it on the consent page and run it again.",
    );
    code = 1;
  } else {
    deps.print(
      `Approved plans written to your Northstar calendar: ${r.written} of ${r.approved}. Held back for later: ${r.skipped}.`,
    );
  }
  // Said whatever stopped the writing, so a letter written earlier in the run is never unmentioned.
  if (r.stuck + r.passedOver > 0) {
    deps.print(
      `In Stuck work on /health: ${r.stuck} new, ${r.passedOver} waiting for you. Retry one there and the next run writes it.`,
    );
  }
  if (r.filed > 0)
    deps.print("Approve or reject the new plans in your Queue, then run this again.");
  return r.stuck > 0 ? 1 : code;
}

// What the calendar read did for this run's plans, in fixed words: a count or the error's class.
export function calendarLine(result: NonNullable<PrepRunReport["calendarBusy"]>): string {
  return "read" in result
    ? `Planned around ${result.read} event(s) from your calendar.`
    : `Couldn't read your calendar (${result.failedBy}): planned around your other interviews and their prep only.`;
}

// Fixed words by the error's class: consent and database errors never echo a token or a value.
function describeError(error: unknown): string {
  const name = errorName(error);
  if (name === "FunnelConfigError" && error instanceof Error) return error.message;
  return `${name} (no details are printed)`;
}
